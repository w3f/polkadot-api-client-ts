import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { KeyringPair$Json, KeyringPair } from '@polkadot/keyring/types';
import { Balance, StakingLedger, AccountInfo } from '@polkadot/types/interfaces'
import { createType, GenericImmortalEra } from '@polkadot/types';
import { Logger, createLogger } from '@w3f/logger';
import fs from 'fs-extra';
import waitUntil from 'async-wait-until';

import { Keystore, ApiClient } from './types';
import { ZeroBalance, ZeroBN } from './constants';


export class Client implements ApiClient {
    private _api: ApiPromise;
    private currentTxDone: boolean;
    private logger: Logger;

    constructor(private readonly wsEndpoint: string, logger?: Logger) {
        if (!logger) {
            this.logger = createLogger();
        } else {
            this.logger = logger;
        }
    }

    public async api(): Promise<ApiPromise> {
        if (this.apiNotReady()) {
            await this.connect();
        }
        return this._api;
    }

    public async balanceOf(addr: string): Promise<Balance> {
        if (this.apiNotReady()) {
            await this.connect();
        }

        const account = await this.getAccount(addr);
        return account.data.free;
    }

    public async balanceOfKeystore(keystore: Keystore): Promise<Balance> {
        if (this.apiNotReady()) {
            await this.connect();
        }
        const keyContents = this.keystoreContent(keystore.filePath);

        return this.balanceOf(keyContents.address);
    }

    public async send(keystore: Keystore, recipentAddress: string, amount: Balance): Promise<void> {
        if (amount.lte(ZeroBalance)) {
            return
        }

        if (this.apiNotReady()) {
            await this.connect();
        }

        const era = createType(
            this._api.registry,
            'ExtrinsicEra',
            new GenericImmortalEra(this._api.registry)
        );

        const senderKeyPair = this.getKeyPair(keystore);

        const account = await this.getAccount(senderKeyPair.address);
        const transfer = this._api.tx.balances.transfer(recipentAddress, amount);
        const transferOptions = {
            blockHash: this._api.genesisHash,
            era,
            nonce: account.nonce
        };
        this.logger.info(`sending ${amount} from ${senderKeyPair.address} to ${recipentAddress}`);
        this.currentTxDone = false;
        try {
            await transfer.signAndSend(
                senderKeyPair,
                transferOptions,
                this.sendStatusCb.bind(this)
            );
        } catch (e) {
            this.logger.info(`Exception during tx sign and send: ${e}`);
        }
        this.logger.info(`after sending ${amount} from ${senderKeyPair.address} to ${recipentAddress}, waiting for transaction done`);

        try {
            await waitUntil(() => this.currentTxDone, 120000, 500);
        } catch (error) {
            this.logger.info(`tx failed: ${error}`);
        }
    }

    public async claim(validatorKeystore: Keystore, controllerAddress: string): Promise<void> {
        if (this.apiNotReady()) {
            await this.connect();
        }

        const maxBatchedTransactions = 9;
        const keyPair = this.getKeyPair(validatorKeystore);

        const currentEra = (await this._api.query.staking.activeEra()).unwrapOr(null);
        if (!currentEra) {
            throw new Error('Could not get current era');
        }
        const ledgerPr = await this._api.query.staking.ledger(controllerAddress);
        const ledger: StakingLedger = ledgerPr.unwrapOr(null);

        if (!ledger) {
            throw new Error(`Could not get ledger for ${keyPair.address}`);
        }
        let lastReward: number;
        if (ledger.claimedRewards.length == 0) {
            lastReward = (await this._api.query.staking.historyDepth()).toNumber();
        } else {
            lastReward = ledger.claimedRewards.pop().toNumber();
        }

        let numOfUnclaimPayouts = currentEra.index - lastReward - 1;
        let start = 1;
        while (numOfUnclaimPayouts > 0) {
            const payoutCalls = [];
            let txLimit = numOfUnclaimPayouts;
            if (numOfUnclaimPayouts > maxBatchedTransactions) {
                txLimit = maxBatchedTransactions;
            }

            for (let i = start; i <= txLimit + start - 1; i++) {
                const idx = lastReward + i;
                const exposure = await this._api.query.staking.erasStakers(idx, keyPair.address);
                this.logger.info(`exposure: ${exposure}`);
                if (exposure.total.toBn().gt(ZeroBN)) {
                    this.logger.info(`Adding claim for ${keyPair.address}, era ${idx}`);
                    payoutCalls.push(this._api.tx.staking.payoutStakers(keyPair.address, idx));
                }
            }
            this.currentTxDone = false;
            try {
                await this._api.tx.utility
                    .batch(payoutCalls)
                    .signAndSend(keyPair, this.sendStatusCb.bind(this));
            } catch (e) {
                this.logger.error(`Could not request claim for ${keyPair.address}: ${e}`);
            }
            try {
                await waitUntil(() => this.currentTxDone, 48000, 500);
            } catch (error) {
                this.logger.info(`tx failed: ${error}`);
            }
            numOfUnclaimPayouts -= txLimit;
            start += txLimit;
        }
        this.logger.info(`All payouts have been claimed for ${keyPair.address}.`);
    }

    private async connect(): Promise<void> {
        const provider = new WsProvider(this.wsEndpoint);
        this._api = await ApiPromise.create({ provider });

        const [chain, nodeName, nodeVersion] = await Promise.all([
            this._api.rpc.system.chain(),
            this._api.rpc.system.name(),
            this._api.rpc.system.version()
        ]);

        this.logger.info(`You are connected to chain ${chain} using ${nodeName} v${nodeVersion}`);
    }

    public disconnect(): void {
        if (this._api) {
            this._api.disconnect();
        }
    }

    private async getAccount(addr: string): Promise<AccountInfo> {
        return this._api.query.system.account(addr);
    }

    private async sendStatusCb({ events = [], status }): Promise<void> {
        if (status.isInvalid) {
            this.logger.info(`Transaction invalid`);
            this.currentTxDone = true;
        } else if (status.isReady) {
            this.logger.info(`Transaction is ready`);
        } else if (status.isBroadcast) {
            this.logger.info(`Transaction has been broadcasted`);
        } else if (status.isInBlock) {
            this.logger.info(`Transaction is in block`);
        } else if (status.isFinalized) {
            this.logger.info(`Transaction has been included in blockHash ${status.asFinalized}`);
            events.forEach(
                async ({ event: { method } }) => {
                    if (method === 'ExtrinsicSuccess') {
                        this.logger.info(`Transaction succeeded`);
                    } else if (method === 'ExtrinsicFailed') {
                        this.logger.info(`Transaction failed`);
                    }
                }
            );
            this.currentTxDone = true;
        }
    }
    private keystoreContent(path: string): KeyringPair$Json {
        return JSON.parse(fs.readFileSync(path, { encoding: 'utf-8' })) as KeyringPair$Json;
    }

    private apiNotReady(): boolean {
        return !this._api;
    }

    private getKeyPair(keystore: Keystore): KeyringPair {
        const keyContents = this.keystoreContent(keystore.filePath);
        const keyType = keyContents.encoding.content[1];
        const keyring = new Keyring({ type: keyType });
        const senderKeyPair = keyring.addFromJson(keyContents);
        const passwordContents = fs.readFileSync(keystore.passwordPath, { encoding: 'utf-8' });
        senderKeyPair.decodePkcs8(passwordContents);

        return senderKeyPair;
    }
}
