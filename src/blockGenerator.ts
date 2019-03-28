import { EthereumHeader, decodeBlock, EthereumTransaction } from '@rainblock/ethereum-block'
import { ConfigurationFile } from './configFile';
import { encodeBlock } from '@rainblock/ethereum-block'
import { RlpList, RlpEncode, RlpDecode } from 'rlp-stream/build/src/rlp-stream';
import { EthereumAccount, EthereumAccountFromBuffer } from './ethereumAccount';
import { VerifierStorageClient, UpdateMsg, grpc, UpdateOp, StorageUpdate, ValueChangeOp, ExecutionOp, CreationOp, DeletionOp, MerklePatriciaTreeNode as ProtocolMerklePatriciaTree} from '@rainblock/protocol'
import { MerklePatriciaTree, CachedMerklePatriciaTree, MerklePatriciaTreeOptions, MerklePatriciaTreeNode } from '@rainblock/merkle-patricia-tree';

import * as fs from 'fs';
import * as path from 'path';
import { hashAsBigInt, hashAsBuffer, HashType } from 'bigint-hash';
import { toBufferBE } from 'bigint-buffer';

export interface BlockGeneratorOptions {
    /** The maximum amount of time the proof of work puzzle takes to solve */
    proofOfWorkTime: number;
    /** The configuration from the configuration file */
    config: ConfigurationFile
    /** The configuratino file directory */
    configDir : string
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
    proofs: Map<bigint, MerklePatriciaTreeNode<Buffer>>;
    /** The write set */
    writeSet : Map<bigint, AccountUpdates>;
}

/** Updates for each account */
export interface AccountUpdates {
    /** The operation type */
    op: UpdateOp | ValueChangeOp | ExecutionOp | CreationOp | DeletionOp;
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
    /** The ordering of transactions in this execution */
    order : TransactionData[]
}

/** Class responsible for performing actual generation of blocks. */
export class BlockGenerator {

    private blockNumber: bigint;
    private parentHash : bigint;
    private difficulty: bigint;
    private gasLimit : bigint;
    private beneficiary : bigint;
    private tree : CachedMerklePatriciaTree<Buffer, Buffer>;
    private verifiers : VerifierStorageClient[];

    private txQueue = new Map<bigint, TransactionData>();

    constructor(private logger: Logger, public options : BlockGeneratorOptions, public running: boolean = true) {
        this.blockNumber = 0n;
        this.parentHash = 0n;
        this.difficulty = 0n;
        this.gasLimit = 0n;

        this.beneficiary = BigInt(`0x${options.config.beneficiary}`);
        this.tree = new CachedMerklePatriciaTree();
        this.verifiers = [];

        logger.debug(`New blocks will be assembled between every 0-${options.proofOfWorkTime/1000} seconds`);
    }

    /** Queue a new transaction to be included in the next block. */
    addTransaction(hash: bigint, data: TransactionData) {
        this.txQueue.set(hash, data);
    }

    /** 'Simulate' solving the proof of work puzzle. We'll solve it by delaying its execution */
    solveProofOfWork(executionResult: ExecutionResult, transactionsRoot: bigint) : Promise<EthereumHeader> {
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
            }), Math.random() * this.options.proofOfWorkTime);
        });
    }

    /** Order and execute the given transaction map. */
    async orderAndExecuteTransactions(transactions : Map<bigint, TransactionData>) : Promise<ExecutionResult> {
        const order : TransactionData[] = [];

        for (const [txHash, tx] of transactions.entries()) {
            this.logger.debug(`Processing tx ${txHash.toString(16)}`);

            try {
                // First, verify that the FROM account can be found and the
                // nonce in the transaction is one greater than the account
                // nonce.
                const fromAccountBinary = 
                    this.tree.getFromCache(hashAsBuffer(HashType.KECCAK256, toBufferBE(tx.tx.from, 32)), tx.proofs);
                if (fromAccountBinary === null) {
                    throw new Error(`From account ${tx.tx.from.toString(16)} does not exist!`);
                } 
                const fromAccount = EthereumAccountFromBuffer(fromAccountBinary);
                if (fromAccount.nonce +1n !== tx.tx.nonce) {
                    throw new Error(`From account ${tx.tx.from.toString(16)} had incorrect nonce ${fromAccount.nonce}, expected ${tx.tx.nonce - 1n}`);
                }


                const toAccountBinary = 
                this.tree.getFromCache(hashAsBuffer(HashType.KECCAK256, toBufferBE(tx.tx.from, 32)), tx.proofs);
                if (toAccountBinary === null) {
                    throw new Error(`To account ${tx.tx.to} does not exist!`);
                } 

                const toAccount = EthereumAccountFromBuffer(toAccountBinary);
                if (toAccount.hasCode()) {
                    // TODO: execute code
                    this.logger.warn(`To account ${tx.tx.to.toString(16)} Code execution not yet implemented`);
                } else {
                    // Simple transfer
                    this.logger.debug(`tx ${txHash.toString(16)} transfer ${tx.tx.value.toString(16)} wei from ${tx.tx.from.toString(16)} -> ${tx.tx.to.toString(16)}`);
                    
                    // TODO : accumulate at -end- to avoid repeats
                    // Need our own non-proto format.
                    const fromOp = new ValueChangeOp();
                    fromOp.setValue(toBufferBE(0n - tx.tx.value, 32));
                    fromOp.setChanges(1);
                    tx.writeSet.set(tx.tx.from, {
                        op: fromOp
                        // And no storage changes
                    })

                    const toOp = new ValueChangeOp();
                    toOp.setValue(toBufferBE(fromAccount.balance + tx.tx.value, 32));
                    toOp.setChanges(0); //0, because destination changes don't increment nonce
                    tx.writeSet.set(tx.tx.to, {
                        op: toOp
                        // And no storage changes
                    })
                }
            order.push(tx);
            } catch (e) {
                this.logger.debug(`Skipping tx ${txHash.toString(16)} due to ${e}`);
            }
        }
        
        return {
            stateRoot: this.tree.rootHash,
            gasUsed: 0n,
            timestamp: BigInt(Date.now()),
            order
        }
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

    /** Propose the block to the list of storage nodes. */
    async proposeBlock(header: EthereumHeader, execution: ExecutionResult) {
        // Encode the new block. We don't support uncles.
        const block = encodeBlock(header, execution.order.map(data => data.txRlp), []);

        const shardRequestList = [];
        // Update each shard
        for (let i = 0; i < 16; i++) {
            const msg = new UpdateMsg();
            msg.setRlpBlock(block);
            msg.setMerkleTreeNodes(
                RlpEncode(this.tree.rootNode.serialize(this.tree.options as MerklePatriciaTreeOptions<{}, Buffer>)));
            // Itereate through the modification list. If it belongs to this shard, add it to the modifications
            for (const tx of execution.order) {
                for (const [acct, updates] of tx.writeSet.entries()) {
                    if (acct >> 152n === BigInt(i)) { // Might use a more optimal way of getting top nibble
                        msg.addOperations(updates.op as UpdateOp);
                    }
                }
            }
            
            shardRequestList.push(new Promise((resolve, reject) => {
                this.verifiers[i].update(msg, (error, response) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            }));
        }

        await Promise.all(shardRequestList);
    }

    /** Every cycle, select as many incoming transactions as possible and
     *  attempt to solve a "proof-of-work" puzzle.
     */
    async generate() {
        const genesisBin = await fs.promises.readFile(path.join(this.options.configDir, this.options.config.genesisBlock));
        const genesisBlock = await decodeBlock(RlpDecode(genesisBin) as RlpList);
        this.parentHash = hashAsBigInt(HashType.KECCAK256, genesisBin);
        this.gasLimit = genesisBlock.header.gasLimit;
        this.difficulty = genesisBlock.header.difficulty;
        this.logger.info(`Parent block set to ${this.parentHash.toString(16)}`);

        // Connect to the storage nodes
        for (let i = 0 ; i < 16; i++) {
            // For now, we only connect to the first node
            const storageNodeAddress = this.options.config.storage[`${i}`];
            this.verifiers[i] = new VerifierStorageClient(storageNodeAddress[0], grpc.credentials.createInsecure());
            await new Promise((resolve, reject) => {
                this.verifiers[i].waitForReady(Date.now() + this.options.config.rpc.storageTimeout, (error=> {
                if (error) {
                    this.logger.warn(`Shard ${i} connection failed: storage node at ${storageNodeAddress}: ${error}`)
                    reject(new Error(`Failed to connect to shard ${i} at ${storageNodeAddress}`))
                } else {
                    this.logger.info(`Shard ${i} connected to storage node at ${storageNodeAddress}`);
                    resolve();
                }
            }))
            });
        }
        
        while (this.running) {
            // Take transactions off of the queue to be included into the new block
            const blockTransactions = this.txQueue;
            this.txQueue = new Map<bigint, TransactionData>();
            this.logger.info(`Assembling new block ${this.blockNumber.toString()} with ${blockTransactions.size} txes`);

            // Decide on which transactions will be included in the block, order and execute them.
            const executionResult = await this.orderAndExecuteTransactions(blockTransactions);

            // Calculate the transactionsRoot
            const transactionsRoot = await this.calculateTransactionsRoot(executionResult.order);

            // Simulate solving the proof of work algorithm.
            const header = await this.solveProofOfWork(executionResult, transactionsRoot);

            // TODO: in parallel, another verifier may advertise a new solution to us.
            // If that is the case we drop our PoW, and verify their block
            // If their block is correct, we adopt their block as the new parentHash
            // and remove and txHashes from that block currently in our queue.

            this.logger.info(`PoW solution found, proposing new block ${this.blockNumber.toString()}`);
            await this.proposeBlock(header, executionResult);

            this.blockNumber++;
        }
    }
}