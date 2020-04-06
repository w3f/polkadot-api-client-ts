import { Keyring } from '@polkadot/api';
import { TestRPC } from '@w3f/test-utils';

import { should } from 'chai';

import { Client } from '../src/client';
import { ZeroBalance } from '../src/constants';

should();

const testRPC = new TestRPC();
const subject = new Client(testRPC.endpoint());
let keyring: Keyring;

describe('TestRPC', () => {
    before(async () => {
        await testRPC.start();
        keyring = new Keyring({ type: 'sr25519' });
    });

    after(async () => {
        await testRPC.stop();
    });

    it('should get a balance', async () => {
        const alice = keyring.addFromUri('//Alice');

        const balance = await subject.balanceOf(alice.address);

        ZeroBalance.lt(balance).should.be.true;
    });
});
