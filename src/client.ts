import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { KeyringPair$Json, KeyringPair } from '@polkadot/keyring/types';
import { Balance } from '@polkadot/types/interfaces'
import { DeriveBalancesAccount } from '@polkadot/api-derive/types'
import { createType, GenericImmortalEra } from '@polkadot/types';
import { Logger, createLogger } from '@w3f/logger';
import fs from 'fs-extra';
import waitUntil from 'async-wait-until';
import { Keystore, ApiClient } from './types';
import { ZeroBalance } from './constants';
import { KeypairType } from '@polkadot/util-crypto/types';


export class Client implements ApiClient {
    protected _api: ApiPromise;
    protected currentTxDone: boolean;
    protected logger: Logger;

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

        const account = await this.getAccountBalances(addr);
        return account.freeBalance
    }

    public async balanceOfKeystore(keystore: Keystore): Promise<Balance> {
        if (this.apiNotReady()) {
            await this.connect();
        }
        const keyContents = this.keystoreContent(keystore.filePath);

        return this.balanceOf(keyContents.address);
    }

    public async send(keystore: Keystore, recipentAddress: string, amount: Balance, isKeepAliveForced = false): Promise<void> {
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

        const account = await this.getAccountBalances(senderKeyPair.address);
        let transfer;
        if(isKeepAliveForced) transfer = this._api.tx.balances.transferKeepAlive(recipentAddress, amount);
        else transfer = this._api.tx.balances.transfer(recipentAddress, amount);
        const transferOptions = {
            blockHash: this._api.genesisHash,
            era,
            nonce: account.accountNonce
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

    protected async connect(): Promise<void> {
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

    private async getAccountBalances(addr: string): Promise<DeriveBalancesAccount> {
        return this._api.derive.balances.account(addr)
    }

    protected async sendStatusCb({ events = [], status }): Promise<void> {
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

    protected apiNotReady(): boolean {
        return !this._api;
    }

    protected getKeyPair(keystore: Keystore): KeyringPair {
        const keyContents = this.keystoreContent(keystore.filePath);
        const keyType = this.parseKeypairType(keyContents.encoding.content[1]);
        const keyring = new Keyring({ type: keyType });
        const senderKeyPair = keyring.addFromJson(keyContents);
        const passwordContents = fs.readFileSync(keystore.passwordPath, { encoding: 'utf-8' });
        senderKeyPair.decodePkcs8(passwordContents);

        return senderKeyPair;
    }

    private parseKeypairType(content: string): KeypairType {
      switch (content.trim().toLowerCase()) {
        case "ed25519":
          return "ed25519"
        case "sr25519":
          return "sr25519"
        case "ecdsa":
          return "ecdsa"
        case "ethereum":
          return "ethereum" 
        default:
          return "sr25519" 
      }
    }
}
