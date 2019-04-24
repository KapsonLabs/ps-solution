import { MerklePatriciaTree } from "@rainblock/merkle-patricia-tree/build/src";
import { EthereumAccount } from './ethereumAccount';

import { hashAsBuffer, hashAsBigInt, HashType } from 'bigint-hash';
import { toBufferBE, toBigIntBE } from 'bigint-buffer';

import {chain} from 'stream-chain';
import {parser} from 'stream-json';
import {pick} from 'stream-json/filters/Pick';
import {streamObject} from 'stream-json/streamers/StreamObject';

import * as zlib from 'zlib';

import * as fs from 'fs';

export interface GethStateDumpAccount {
    balance : string;
    nonce : number;
    root: string;
    codeHash: string;
    code: string;
    storage: { [key : string] : string};
}

export interface GethStateDump {
    root : string;
    accounts: { [id : string] : GethStateDumpAccount };
}

export async function ImportGethDump(path: string, tree: MerklePatriciaTree<Buffer, EthereumAccount>, codeMap: Map<bigint, Buffer>, compressed = false) {
    if (!compressed) {
        const json = JSON.parse(await fs.promises.readFile(path, { encoding: 'utf8'} )) as GethStateDump;
        for (const [id, account] of Object.entries(json.accounts)) {
            // TODO: currently, this only supports accounts without storage
            if (Object.entries(account.storage).length > 0) {
                throw new Error('Proof state file with storage not yet supported');
            }
            const code = Buffer.from(account.code, 'hex');
            const codeHash = hashAsBigInt(HashType.KECCAK256, code);
            if (account.codeHash !== codeHash.toString(16)) {
                throw new Error(`Codehash for account ${id} did not match calcuated hash: got ${codeHash.toString(16)}, expected ${account.codeHash}`);
            }
            const parsedAccount = new EthereumAccount(BigInt(account.nonce), BigInt(account.balance), codeHash, EthereumAccount.EMPTY_BUFFER_HASH);
            tree.put(hashAsBuffer(HashType.KECCAK256, toBufferBE(BigInt(`0x${id}`), 20)), parsedAccount);
        }
    }
    else {
        const pipeline = chain([
            fs.createReadStream(path),
            zlib.createGunzip(),
            parser(),
            pick({filter: 'accounts'}),
            streamObject(),
          ]);
        for await (const data of pipeline) {
            const account = data.value;
            const id = data.key;
            // TODO: currently, this only supports accounts without storage
            if (Object.entries(account.storage).length > 0) {
                throw new Error('Proof state file with storage not yet supported');
            }
            const code = Buffer.from(account.code, 'hex');
            const codeHash = hashAsBigInt(HashType.KECCAK256, code);
            if (account.codeHash !== codeHash.toString(16)) {
                throw new Error(`Codehash for account ${id} did not match calcuated hash: got ${codeHash.toString(16)}, expected ${account.codeHash}`);
            }
            const parsedAccount = new EthereumAccount(BigInt(account.nonce), BigInt(account.balance), codeHash, EthereumAccount.EMPTY_BUFFER_HASH);
            tree.put(hashAsBuffer(HashType.KECCAK256, toBufferBE(BigInt(`0x${id}`), 20)), parsedAccount);
        }
    }
}