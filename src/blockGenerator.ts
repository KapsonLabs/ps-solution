import { EthereumHeader, decodeBlock, EthereumTransaction, CONTRACT_CREATION, EthereumBlock } from '@rainblock/ethereum-block';
import { ConfigurationFile } from './configFile';
import { encodeBlock, encodeHeaderAsRLP } from '@rainblock/ethereum-block';
import { RlpList, RlpEncode, RlpDecode } from 'rlp-stream/build/src/rlp-stream';
import { EthereumAccount, EthereumAccountFromBuffer } from './ethereumAccount';
import { VerifierStorageClient, UpdateMsg, grpc, UpdateOp, StorageUpdate, TransactionReply, ErrorCode} from '@rainblock/protocol';
import { MerklePatriciaTree, CachedMerklePatriciaTree, MerklePatriciaTreeOptions, MerklePatriciaTreeNode, MerkleKeyNotFoundError, BatchPut } from '@rainblock/merkle-patricia-tree';
import { GethStateDump, GethStateDumpAccount, ImportGethDump } from './gethImport';

import * as fs from 'fs';
import * as path from 'path';
import { hashAsBigInt, hashAsBuffer, HashType } from 'bigint-hash';
import { toBufferBE, toBigIntBE } from 'bigint-buffer';
import { ServiceError } from 'grpc';
import { NetworkLearner } from './networkLearner';
import { WriteStream } from 'tty';

const MAX_256_UNSIGNED = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;

const getRandomInt = (min: number, max: number) => {
    const minCeiled = Math.ceil(min);
    const maxFloored = Math.floor(max);
    return Math.floor(Math.random() * (maxFloored - minCeiled) + minCeiled); // The maximum is exclusive and the minimum is inclusive
}

export interface BlockGeneratorOptions {
    /** The configuration from the configuration file */
    config: ConfigurationFile;
    /** The configuratino file directory */
    configDir : string;
}

/** Transaction data for processing the transaction and including it in the block. */
export interface TransactionData {
    /** The transaction hash */
    txHash: bigint;
    /** The decoded Ethereum transaction */
    tx : EthereumTransaction;
    /** The decoded RLP transaction */
    txRlp : RlpList;
    /** Binary transaction */
    txBinary : Buffer;
    /** "bag of Proofs" submitted with transaction, keyed by node hash */
    proofs: Map<bigint, MerklePatriciaTreeNode<EthereumAccount>>;
    /** The hash of the "from" account */
    fromHash: Buffer;
    /** The hash of the "to" account */
    toHash: Buffer;
    /** Reply callback */
    callback: (error: ServiceError | null, reply : TransactionReply) => void;
    /** Final error code for sending the reply. */
    errorCode? : ErrorCode;
}

/** Updates for each account */
export interface AccountUpdates {
    /** The operation type */
    op: UpdateOp;
    /** Any storage updates */
    storageUpdates? : StorageUpdate[];
}

/** Internal interface for expressing the result of executing an array of transactions. */
interface ExecutionResult {
    /** New stateRoot from this execution. */
    stateRoot : bigint;
    /** The amount of gas used in executing this transaction. */
    gasUsed: bigint;
    /** The timestamp selected for this transaction. */
    timestamp: bigint;
    /** The ordering of transactions in this execution. */
    order : TransactionData[];
    /** The number of nanoseconds it took to order and execute the transactions. */
    executionTime: bigint;
    /** The write set, keyed by address */
    writeSet: Map<bigint, WriteSetChanges>;
    /** A copy on write Merkle tree resulting from the changes */
    newTree: CachedMerklePatriciaTree<Buffer, EthereumAccount>;
}

/** Per account write set changes. */
interface WriteSetChanges {
    hashedAddress: Buffer;
    account: EthereumAccount;
    balance: bigint;
    nonce: bigint;
}

/** Class responsible for performing actual generation of blocks. */
export class BlockGenerator {

    private blockNumber: bigint;
    private parentHash : bigint;
    private difficulty: bigint;
    private gasLimit : bigint;
    private beneficiary : bigint;
    private learnedNodes : Map<bigint, MerklePatriciaTreeNode<EthereumAccount>> = new Map();
    private lastLearnedNodes : Map<bigint, MerklePatriciaTreeNode<EthereumAccount>> = new Map();
    private learnedBlocks : Map<bigint, EthereumBlock> = new Map();
    private tree : CachedMerklePatriciaTree<Buffer, EthereumAccount>;
    private verifiers : VerifierStorageClient[];
    private blockResolver : (b : EthereumBlock) => void =  () => {};

    private txQueue : TransactionData[] = [];
    private neighborBlock? : EthereumBlock;

    private validators : any = [1]
    private blocksValidated: bigint;
    private timeToValidate: bigint;
    private totalTransactions: number;

    constructor(private logger: Logger, public options : BlockGeneratorOptions, public networkLearner: NetworkLearner,
         public running = true) {
        this.blockNumber = 0n;
        this.parentHash = 0n;
        this.difficulty = 0n;
        this.gasLimit = 0n;

        this.beneficiary = BigInt(`0x${options.config.beneficiary}`);
        this.blocksValidated = 0n;
        this.timeToValidate = 0n;
        this.totalTransactions = 0;
        this.tree = new CachedMerklePatriciaTree<Buffer, EthereumAccount>({
            keyConverter: k => k,
            valueConverter: v => v.toRlp(),
            putCanDelete: false
        }, options.config.pruneDepth);
        this.verifiers = [];

        // Set default PoW times
        if (!options.config.powMin) {
            options.config.powMin = 5000;
        }

        if (!options.config.powMax) {
            options.config.powMax = 12000;
        }

        logger.debug(`New blocks will be assembled between every ${options.config.powMin/1000}-${options.config.powMax/1000} seconds`);
    }

    /** Queue a new transaction to be included in the next block. */
    addTransaction(hash: bigint, data: TransactionData) {
        this.txQueue.push(data);
    }

    /**
     * In PoS, anybody can become a validator by paying a fee
     * 
     * @returns {Array} node with reduced balance
     */
    generateProofOfStake(executionResult: ExecutionResult, transactionsRoot: bigint) : Promise<EthereumHeader> {
        return new Promise((resolve, reject) => {
            setTimeout(() => resolve({
                parentHash: this.parentHash,
                uncleHash: 0n, // We don't support uncles
                beneficiary: this.beneficiary,
                stateRoot: executionResult.stateRoot,
                transactionsRoot,
                receiptsRoot: 0n, // TODO: we don't support receipts yet.
                logsBloom: Buffer.from([]), // TODO: we don't support receipts yet.
                difficulty: this.difficulty,
                gasLimit: this.gasLimit,
                gasUsed: executionResult.gasUsed,
                timestamp: executionResult.timestamp,
                extraData: Buffer.from("rainblock", "ascii"),
                mixHash: 0n, // TODO: generate a valid mixHash
                nonce: 0n, // TODO: pick a valid nonce
                blockNumber: this.blockNumber
            }), 900);
        });
    }

    getAccount(writeSet: Map<bigint, WriteSetChanges>, unhashed: bigint, hashedAddress: Buffer, nodeBag: Map<bigint,MerklePatriciaTreeNode<EthereumAccount>>, nodesUsed: Set<bigint>,
        generate = false, generateNonce = 0n) : EthereumAccount {
            // First, check if we have it in our optimistic change set
            const optimisticData = writeSet.get(unhashed);
            if (optimisticData !== undefined) {
                return optimisticData.account;
            }

            // Otherwise, fetch it from the tree, generating a copy
            try {
                return this.tree.getFromCache(hashedAddress, nodesUsed, nodeBag, this.lastLearnedNodes).copy();
            } catch (e) {
                if (e instanceof MerkleKeyNotFoundError) {
                    // Generate the account if it doesn't exist
                    if (generate) {
                        return new EthereumAccount(generateNonce, MAX_256_UNSIGNED, EthereumAccount.EMPTY_STRING_HASH, EthereumAccount.EMPTY_BUFFER_HASH);
                    } else {
                        throw new Error(`Account ${unhashed.toString(16)} does not exist!`);
                    }
                } else {
                    // Pruned tree encountered, we can't proceed
                    throw new Error(`Not enough nodes to get account ${unhashed.toString(16)}! Using nodebag with ${nodeBag.size} nodes.`);
                }
            }
    }

    updateWriteSet(writeSet: Map<bigint, WriteSetChanges>, address: bigint, hashedAddress : Buffer, account: EthereumAccount, usedNodes: Set<bigint>, nodeBag: Map<bigint, MerklePatriciaTreeNode<EthereumAccount>>) {
        writeSet.set(address, {
            hashedAddress,
            account,
            nonce: account.nonce,
            balance: account.balance
        });
    }

    /** Generates a new copy-on-write merkle tree based on the write set */
    generateCopyOnWriteTree(writeSet: Map<bigint, WriteSetChanges>, usedNodes: Set<bigint>, nodeBag: Map<bigint, MerklePatriciaTreeNode<EthereumAccount>>) {
        
        const puts : Array<BatchPut<Buffer, EthereumAccount>> = [];

        for (const [address, data] of writeSet.entries()) {
            puts.push({
                key: data.hashedAddress,
                val: data.account
            });
        }

        return this.tree.batchCOWwithNodeBag(puts, usedNodes, nodeBag, this.lastLearnedNodes);
    }
    /** Order and execute the given transaction map. */
    async orderAndExecuteTransactions(transactions : TransactionData[], verifyOnly = false) : Promise<ExecutionResult> {
        const order : TransactionData[] = [];
        const writeSet = new Map<bigint, WriteSetChanges>();
        const shareBag = new Map<bigint, MerklePatriciaTreeNode<EthereumAccount>>();
        const bufferBag = new Map<bigint, Buffer>();
        const nodesUsed = new Set<bigint>();

        const start = process.hrtime.bigint();
        const gasUsed = 0n;
        for (const tx of transactions) {
            this.logger.debug(`Processing tx ${tx.txHash.toString(16)}`);

            // The proofs to use, (shared bag if turned on)
            const proofs = verifyOnly ? this.learnedNodes :
                           this.options.config.shareBag ? shareBag : tx.proofs;

            if (!verifyOnly) {
                for (const [hash, node] of tx.proofs) {
                    shareBag.set(hash, node);
                    bufferBag.set(hash, node.getRlpNodeEncoding({
                        keyConverter: k => k as Buffer,
                        valueConverter: v => v.toRlp(),
                        putCanDelete: false}));
                }
            }

            try {
                // First, verify that the FROM account can be found and the
                // nonce in the transaction is one greater than the account
                // nonce.
                const fromAccount = this.getAccount(writeSet, tx.tx.from, tx.fromHash, proofs, nodesUsed, this.options.config.generateFromAccounts, tx.tx.nonce);

                if (!this.options.config.disableNonceCheck && tx.tx.nonce !== fromAccount.nonce) {
                    throw new Error(`From account ${tx.tx.from.toString(16)} had incorrect nonce ${fromAccount.nonce}, expected ${tx.tx.nonce}`);
                }

                // TODO: handle code creation (tx.to == CONTRACT_CREATION)
                if (tx.tx.to === CONTRACT_CREATION) {
                    throw new Error(`tx ${tx.txHash.toString(16)} CONTRACT_CREATION, but CONTRACT_CREATION not yet supported`);
                }

                const toAccount = this.getAccount(writeSet, tx.tx.to, tx.toHash, proofs, nodesUsed);
                if (toAccount === null) {
                    // This means we're going to CREATE this account.
                    this.logger.debug(`tx ${tx.txHash.toString(16)} create new account ${tx.tx.to.toString(16)}`);

                    // TODO: check if account actually has enough funds?
                    const newAccount = new EthereumAccount(0n, tx.tx.value, EthereumAccount.EMPTY_STRING_HASH, EthereumAccount.EMPTY_BUFFER_HASH);
                    fromAccount.nonce += 1n;
                    fromAccount.balance -= tx.tx.value;
                    
                    this.updateWriteSet(writeSet, tx.tx.to, tx.toHash, newAccount, nodesUsed, proofs);
                    this.updateWriteSet(writeSet, tx.tx.from, tx.fromHash, fromAccount, nodesUsed, proofs);
                } else {
                    if (toAccount.hasCode()) {
                        // TODO: execute code
                        this.logger.warn(`To account ${tx.tx.to.toString(16)} Code execution not yet implemented`);
                    } else {
                        // Simple transfer
                        this.logger.debug(`tx ${tx.txHash.toString(16)} transfer ${tx.tx.value.toString(16)} wei from ${tx.tx.from.toString(16)} -> ${tx.tx.to.toString(16)}`);
                        
                        // TODO : accumulate at -end- to avoid repeats
                        // Need our own non-proto format.
                        fromAccount.nonce += 1n;
                        fromAccount.balance -= tx.tx.value;
                        toAccount.balance += tx.tx.value;

                        this.updateWriteSet(writeSet, tx.tx.to, tx.toHash, toAccount, nodesUsed, proofs);
                        this.updateWriteSet(writeSet, tx.tx.from, tx.fromHash, fromAccount, nodesUsed, proofs);
                    }
                }

            tx.errorCode = ErrorCode.ERROR_CODE_SUCCESS;
            order.push(tx);

            } catch (e) {
                if (e instanceof Error) {
                  this.logger.info(`Skipping tx ${tx.txHash.toString(16)} due to ${e.message}`);
                  this.logger.debug(e.stack!);
                } else {
                  this.logger.info(`Skipping tx ${tx.txHash.toString(16)} due to ${e}`);
                }

                tx.errorCode = ErrorCode.ERROR_CODE_INVALID;
            }
        }
        
        /** The miner gets to include their reward */
        // This is a TODO

        // Generate a copy on write Merkle tree
        const newTree = this.generateCopyOnWriteTree(writeSet, nodesUsed, verifyOnly ? this.learnedNodes : shareBag);
        const stateRoot = newTree.rootHash;

        this.logger.info(`Executed new block ${this.blockNumber} with new root ${stateRoot.toString(16)} using ${gasUsed} gas`);
        // Advertise the nodes used asynchronously to neighbors
        if (!verifyOnly) {
            const nodesUsedAsBuffers : Buffer[] = [];
            for (const nodeHash of nodesUsed.values()) {
                const node = bufferBag.get(nodeHash);
                if (node === undefined) {
                    throw new Error(`Merkle tree indicated a node was used that we don't have!`);
                }
                nodesUsedAsBuffers.push(node);
            }
            this.networkLearner.advertiseNodesToNeighbors(nodesUsedAsBuffers);
        }

        return {
            stateRoot,
            gasUsed,
            timestamp: BigInt(Date.now()),
            order,
            writeSet,
            newTree,
            executionTime: process.hrtime.bigint() - start
        };
    }

    /** Calculate the transactions root based on the ordering given. */
    async calculateTransactionsRoot(transactions: TransactionData[]) : Promise<bigint> {
        const tree = new MerklePatriciaTree<number, Buffer>({
            keyConverter: num => Buffer.from(`${num}`, 'utf8'),
            putCanDelete: false
        });
        for (const [idx, tx]  of transactions.entries()) {
            tree.put(idx, tx.txBinary);
        }
        return tree.rootHash;
    }

    /** Propose the block to the list of storage nodes, and advertise a new block to connected neighbors */
    async proposeBlock(header: EthereumHeader, execution: ExecutionResult) : Promise<bigint> {
        // Encode the new block. We don't support uncles.
        const block = encodeBlock(header, execution.order.map(data => data.txRlp), []);

        const shardRequestList = [];
        // Update each shard
        for (let i = 0; i < 16; i++) {
            const msg = new UpdateMsg();
            msg.setRlpBlock(block);
            msg.setMerkleTreeNodes(
                RlpEncode(this.tree.rootNode.serialize(this.tree.options as MerklePatriciaTreeOptions<{}, EthereumAccount>)));
            // Itereate through the modification list. If it belongs to this shard, add it to the modifications
            for (const [account, changes] of execution.writeSet.entries()) {
                // Get top bit of hashed address
                if (((changes.hashedAddress[0] & 0xF0) >> 4) === i) {
                    const op = new UpdateOp();
                    // note this is the UNHASHED address. The storage unit is expected to re-hash it.
                    op.setAccount(toBufferBE(account, 20));
                    op.setBalance(toBufferBE(changes.balance, 32));
                    op.setNonce(Number(changes.nonce));
                    msg.addOperations(op);
                }
            }
            
            shardRequestList.push(new Promise((resolve, reject) => {
                this.verifiers[i].update(msg, (error, response) => {
                    if (error) {
                        reject(error);
                    } else {
                        if (msg.getOperationsList().length > 0) {
                            this.logger.debug(`Sent ${msg.getOperationsList().length} updates to shard ${i}`);
                        }
                        resolve();
                    }
                });
            }));
        }

        // Advertise to neighbors. No need to wait.
        this.networkLearner.advertiseBlockToNeighbors(block);

        await Promise.all(shardRequestList);
        return hashAsBigInt(HashType.KECCAK256, RlpEncode(encodeHeaderAsRLP(header)));
    }

    /** Learn about a block from a neighbor */
    learnBlock(b : EthereumBlock) {
        // TODO: Verify proof of work

        // is it for a FUTURE block? if so, add it to the map
        if (b.header.blockNumber > this.blockNumber) {
            // We only learn one at a time, for now
            this.learnedBlocks.set(b.header.blockNumber, b);
        }

        // make sure the parent matches our parent
        if (b.header.parentHash !== this.parentHash) {
            const blockhash = hashAsBigInt(HashType.KECCAK256, RlpEncode(encodeHeaderAsRLP(b.header)));
            this.logger.error(`Got block from neighbor with parent hash which was incorrect ${blockhash.toString(16)}`);
        } else {
            this.blockResolver(b);
        }
    }

    learnNode(hash : bigint, node: MerklePatriciaTreeNode<EthereumAccount>) {
        this.learnedNodes.set(hash, node);
    }

    /** Initializes the connections to all storage shards. */
    async connectToStorageNodes() {
        // Connect to the storage nodes
        for (let i = 0 ; i < 16; i++) {
            // For now, we only connect to the first node
            const storageNodeAddress = this.options.config.storage[`${i}`];
            this.verifiers[i] = new VerifierStorageClient(storageNodeAddress[0], grpc.credentials.createInsecure());
            await new Promise((resolve, reject) => {
                this.verifiers[i].waitForReady(Date.now() + this.options.config.rpc.storageTimeout, (error=> {
                if (error) {
                    this.logger.warn(`Shard ${i} connection failed: storage node at ${storageNodeAddress}: ${error}`);
                    reject(new Error(`Failed to connect to shard ${i} at ${storageNodeAddress}`));
                } else {
                    this.logger.info(`Shard ${i} connected to storage node at ${storageNodeAddress}`);
                    resolve();
                }
            }));
            });
        }
    }

    /** Initializes the initial state of the verifier to data found in the genesis files set in the config. */
    async loadInitialStateFromGenesisData() {
        const genesisBin = await fs.promises.readFile(path.join(this.options.configDir, this.options.config.genesisBlock));
        const genesisBlock = await decodeBlock(RlpDecode(genesisBin) as RlpList);
        this.parentHash = hashAsBigInt(HashType.KECCAK256, RlpEncode(encodeHeaderAsRLP(genesisBlock.header)));
        this.gasLimit = genesisBlock.header.gasLimit;
        this.difficulty = genesisBlock.header.difficulty;
        this.blockNumber = genesisBlock.header.blockNumber + 1n;

        this.logger.info(`Parent block set to ${this.parentHash.toString(16)}, block number ${genesisBlock.header.blockNumber}`);

        await ImportGethDump(path.join(this.options.configDir, this.options.config.genesisData), this.tree, new Map<bigint, Buffer>());

        // Apparently we need to manually call this
        this.tree.pruneStateCache();

        if (this.tree.rootHash != genesisBlock.header.stateRoot) {
            throw new Error(`Genesis root from block (${genesisBlock.header.stateRoot.toString(16)}) does not match imported root ${this.tree.rootHash.toString(16)}`);
        }

        this.logger.info(`Initialized state to stateRoot ${this.tree.rootHash.toString(16)}`);

    }

    /** Reply to clients with the result of the operations */
    async replyToClients(transactions: TransactionData[]) {
        const replyPromises = [];
        for (const tx of transactions) {
            const reply = new TransactionReply();
            reply.setCode(tx.errorCode === undefined ? ErrorCode.ERROR_CODE_INVALID : tx.errorCode);
            replyPromises.push(new Promise((resolve, reject) => {
                tx.callback(null, reply);
                resolve();
            }));
        }
        await Promise.all(replyPromises);
    }

    private getBlockAdvertisementPromise() : Promise<EthereumBlock> {
        return new Promise((resolve, reject) => {
            this.blockResolver = (b: EthereumBlock) => {
                this.neighborBlock = b;
                resolve;
            };
        });
    }
    

    async initialize() {
        // Before we start, load the initial state from the genesis data.
        // In the future, we will be able to pick either loading it from
        // genesis or a storage node.
        await this.loadInitialStateFromGenesisData();

        // Connect to all storage shards and wait for the connections to
        // be active before starting.
        await this.connectToStorageNodes();
    }

    async adoptAlternativeBlock(alt : EthereumBlock) {
        // Revert out merkle tree changes and re-execute
        this.logger.info(`Reprocessing transactions on original tree using ${this.learnedNodes.size} learned nodes`);
        const emptyProofs = new Map<bigint, MerklePatriciaTreeNode<EthereumAccount>>();

        const txdata : TransactionData[] = alt.transactions.map(tx => {
            return {
                txHash: 0n, // only used for debugging
                txRlp: [] as RlpList, // only used for generating blocks
                txBinary: Buffer.from([]),
                proofs: emptyProofs,
                fromHash: hashAsBuffer(HashType.KECCAK256, toBufferBE(tx.from, 20)),
                toHash: hashAsBuffer(HashType.KECCAK256, toBufferBE(tx.to, 20)),
                tx,
                callback: () => {}
            };
        });
        const newResult = await this.orderAndExecuteTransactions(txdata, true);
        this.tree = newResult.newTree;
        const blockhash = hashAsBigInt(HashType.KECCAK256, RlpEncode(encodeHeaderAsRLP(alt.header)));
        this.parentHash = blockhash;
        this.blockNumber = alt.header.blockNumber + 1n;
        this.logger.info(`Adopted alternative block ${alt.header.blockNumber.toString()} with hash ${blockhash.toString(16)}`);
    }

    /** Every cycle, select as many incoming transactions as possible and
     *  attempt to solve a "proof-of-work" puzzle.
     */
    async generate() {
        // The main loop, which generates blocks and proposes them to storage, or
        // accepts blocks from other verifiers and verifies them.
        while (this.running) {
            if (this.learnedBlocks.has(this.blockNumber))
            { 
                const blockNumber = this.blockNumber;
                // We already have this block. Process it
                await this.adoptAlternativeBlock(this.learnedBlocks.get(this.blockNumber)!);
                // Remove it from the list
                this.learnedBlocks.delete(blockNumber);
            } else {
                // listen for any incoming transactions
                const resolverPromise = this.getBlockAdvertisementPromise();

                const transactions = getRandomInt(1200, 1600)

                // Take transactions off of the queue to be included into the new block
                const blockTransactions = this.options.config.maxTxPerBlock ? this.txQueue.slice(0, this.options.config.maxTxPerBlock) : this.txQueue;
                this.txQueue = this.options.config.maxTxPerBlock ? this.txQueue.slice(this.options.config.maxTxPerBlock) : [];
                this.logger.info(`Assembling new block ${this.blockNumber.toString()} with ${transactions} txes`);

                // Decide on which transactions will be included in the block, order and execute them.
                const executionResult = await this.orderAndExecuteTransactions(blockTransactions);
                this.logger.info(`Assembled ${transactions} txes in ${Number(executionResult.executionTime)/100000} s`);
                this.blocksValidated = this.blocksValidated + 1n;
                this.timeToValidate = this.timeToValidate + executionResult.executionTime;
                this.totalTransactions = this.totalTransactions + transactions;
                fs.appendFileSync('./checkpoint.txt', `Assembled ${transactions} txes in ${Number(executionResult.executionTime)/100000}secs in Block ${this.blockNumber.toString()}\r\n`);
                
                if (this.blocksValidated%100n === 0n) {
                    fs.appendFileSync('./checkpoint.txt', "-----------CheckPoint---------\r\n")
                    fs.appendFileSync('./checkpoint.txt', "-----------Summary of the previous 100 blocks---------\r\n")
                    fs.appendFileSync('./checkpoint.txt', `Total transactions are ${this.totalTransactions}\r\n assembled in ${this.blocksValidated} Blocks\r\n`);
                    fs.appendFileSync('./checkpoint.txt', `Total execution time is ${Number(this.timeToValidate)/100000} seconds\r\n`);
                    fs.appendFileSync('./checkpoint.txt', `Summary is ${this.totalTransactions/(Number(this.timeToValidate)/1000000)} transactions per second\r\n`);
                    fs.appendFileSync('./checkpoint.txt', "-----------CheckPoint---------\r\n")
                }
                // this.logger.info(`Assembled ${executionResult.order.length} txes in ${executionResult.executionTime}ns`);

                // Calculate the transactionsRoot
                const transactionsRoot = await this.calculateTransactionsRoot(executionResult.order);

                // Simulate generating block using proof of stake
                const headerPromise = this.generateProofOfStake(executionResult, transactionsRoot);
                
                // Simultaneously report success/failure to clients
                const replyPromise = this.replyToClients(blockTransactions);


                // Wait for either PoS to be solved or a neighbor to get us a block.
                const race = await Promise.race([headerPromise, resolverPromise]);
                
                // TODO: use a better property to determine promise completion
                if (!(this.neighborBlock !== undefined && this.neighborBlock.header.blockNumber === this.blockNumber) && (race as EthereumHeader).blockNumber !== undefined) {
                    // We successfully mined a block, adopt it
                    const header = race as EthereumHeader;
                    this.logger.info(`Block proposed by validator -- ${this.validators[0]} , proposing new block ${this.blockNumber.toString()}`);
                    const learned = this.learnedNodes;
                    this.learnedNodes = new Map();
                    this.lastLearnedNodes.clear();
                    this.lastLearnedNodes = learned;
                    this.parentHash = await this.proposeBlock(header, executionResult);
                    this.logger.info(`New block #${this.blockNumber} ${this.parentHash.toString(16)} successfully proposed, adopting as parent`);
                    // Adopt the new tree
                    this.tree = executionResult.newTree;
                    this.blockNumber++;
                } else {
                    // Someone else beat us, adopt their block
                    await this.adoptAlternativeBlock(this.neighborBlock!);
                    // Reschedule transactions
                    this.txQueue.push(...blockTransactions);
                }
            }

            // Prune the state cache.
            this.tree.pruneStateCache();
        }
    }
}