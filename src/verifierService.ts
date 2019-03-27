import {  TransactionRequest, TransactionReply, IVerifierServer, ErrorCode, grpc} from '@rainblock/protocol'
import { decodeTransaction, CONTRACT_CREATION } from '@rainblock/ethereum-block'
import { RlpDecode, RlpList } from 'rlp-stream';
import { BlockGenerator, AccountUpdates } from './blockGenerator';
import { hashAsBigInt, HashType } from 'bigint-hash';

export class VerifierServer implements IVerifierServer {

    constructor(private logger: Logger, private blockGenerator : BlockGenerator) {
    }

    /** Submit a transaction from the client to the verifier. */
    async submitTransaction(call: grpc.ServerUnaryCall<TransactionRequest>, 
        callback: grpc.sendUnaryData<TransactionReply>) {

        // First grab the TX. Also hash the transaction data.
        const txBinary = call.request.getTransaction_asU8() as Buffer;
        const txRlp = RlpDecode(txBinary) as RlpList;
        const tx = await decodeTransaction(txRlp);
        const txHash = hashAsBigInt(HashType.KECCAK256, txBinary);
        this.logger.debug(`Got tx from ${call.getPeer()} from ${tx.from.toString(16)} to ${tx.to.toString(16)}`);

        // Transform the partial tree into a map we can reference
        const proofs = new Map<bigint, Buffer>();
        for (const witness of call.request.getAccountWitnessesList_asU8()) {
            proofs.set(hashAsBigInt(HashType.KECCAK256, witness as Buffer), witness as Buffer);
        }

        // Queue the transaction to be added into the next block
        this.blockGenerator.addTransaction(txHash, {
            txHash,
            txRlp,
            txBinary,
            tx,
            proofs,
            writeSet: new Map<bigint, AccountUpdates>()
        });

        const reply = new TransactionReply();
        reply.setCode(ErrorCode.ERROR_CODE_SUCCESS);
        callback(null, new TransactionReply())
    }
}