import { Balance } from '@polkadot/types/interfaces'

export interface Keystore {
    filePath: string;
    passwordPath: string;
}

export interface ApiClient {
    balanceOf(addr: string): Promise<Balance>;
    balanceOfKeystore(keystore: Keystore): Promise<Balance>;
    send(keystore: Keystore, recipentAddress: string, amount: Balance): Promise<void>;
    connect(): Promise<void>;
    disconnect(): void;
}
