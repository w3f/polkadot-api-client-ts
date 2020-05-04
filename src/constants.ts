import { Balance } from '@polkadot/types/interfaces';
import BN from 'bn.js';

export const ZeroBN = new BN(0);
export const ZeroBalance = ZeroBN as Balance;
export const MinimumSenderBalance = new BN(1000000000000) as Balance;
