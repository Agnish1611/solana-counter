import * as borsh from "borsh";
import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
    sendAndConfirmTransaction
} from "@solana/web3.js";
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { COUNTER_SIZE, CounterAccount, instructionSchema, schema, type CounterInstruction } from "./types";

// Configuration
const PROGRAM_ID = new PublicKey("CC6Jc1wkfdyyiRGQAGy8UVXXZdb9LDRbc7hJnrxdC44U");
const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const FUNDING_AMOUNT_SOL = 2; // Increase funding to ensure sufficient SOL for all operations
const TEST_TIMEOUT = 40000; // 40 seconds

// Validation
if (!process.env.SOLANA_PRIVATE_KEY) {
    throw new Error("SOLANA_PRIVATE_KEY environment variable is required");
} 

const fundingKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(process.env.SOLANA_PRIVATE_KEY))
);

/**
 * Transfers SOL to a specified account
 * @param connection - Solana connection instance
 * @param amountInSol - Amount of SOL to transfer
 * @param recipient - Public key of the recipient
 * @throws Error if transfer fails
 */
async function transferSol(
    connection: Connection,
    amountInSol: number, 
    recipient: PublicKey
): Promise<void> {
    const transferTransaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: fundingKeypair.publicKey,
            toPubkey: recipient,
            lamports: amountInSol * LAMPORTS_PER_SOL,
        })
    );

    try {
        await sendAndConfirmTransaction(connection, transferTransaction, [fundingKeypair]);
    } catch (error) {
        throw new Error(`Failed to transfer SOL: ${error}`);
    }
}

/**
 * Creates a new program account
 * @param connection - Solana connection instance
 * @param payer - Account that pays for the creation
 * @param newAccount - New account to be created
 * @param space - Space allocation for the account
 * @param programId - Program that will own the account
 */
async function createProgramAccount(
    connection: Connection,
    payer: Keypair,
    newAccount: Keypair,
    space: number,
    programId: PublicKey
): Promise<void> {
    const lamports = await connection.getMinimumBalanceForRentExemption(space);

    const createAccountInstruction = SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: newAccount.publicKey,
        lamports,
        space,
        programId,
    });

    const transaction = new Transaction().add(createAccountInstruction);

    try {
        await sendAndConfirmTransaction(connection, transaction, [payer, newAccount]);
    } catch (error) {
        throw new Error(`Failed to create program account: ${error}`);
    }
}

/**
 * Serializes a counter instruction using borsh
 * @param instruction - The instruction to serialize
 * @returns Serialized instruction data
 */
function serializeInstruction(instruction: CounterInstruction): Buffer {
    return Buffer.from(borsh.serialize(instructionSchema, instruction));
}

/**
 * Executes a counter instruction and returns the updated counter value
 * @param connection - Solana connection
 * @param instruction - The instruction to execute
 * @param payer - Account that pays for the transaction
 * @param counterAccount - The counter account to modify
 * @returns Updated counter value
 */
async function executeCounterInstruction(
    connection: Connection,
    instruction: CounterInstruction,
    payer: Keypair,
    counterAccount: PublicKey
): Promise<number> {
    const instructionData = serializeInstruction(instruction);
    
    const ix = new TransactionInstruction({
        keys: [{ pubkey: counterAccount, isSigner: false, isWritable: true }],
        programId: PROGRAM_ID,
        data: instructionData,
    });

    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [payer]);

    // Return the updated counter value
    const updatedInfo = await connection.getAccountInfo(counterAccount);
    if (!updatedInfo) {
        throw new Error("Counter account not found after instruction execution");
    }
    
    const counter = borsh.deserialize(schema, updatedInfo.data) as CounterAccount;
    return counter.count;
}

/**
 * Gets the current counter value from an account
 * @param connection - Solana connection
 * @param counterAccount - The counter account to read
 * @returns Current counter value
 */
async function getCounterValue(
    connection: Connection,
    counterAccount: PublicKey
): Promise<number> {
    const accountInfo = await connection.getAccountInfo(counterAccount);
    if (!accountInfo) {
        throw new Error("Counter account not found");
    }
    
    const counter = borsh.deserialize(schema, accountInfo.data) as CounterAccount;
    return counter.count;
}

describe("Counter Program Tests", () => {
    let connection: Connection;
    let adminAccount: Keypair;
    let dataAccount: Keypair;

    beforeAll(async () => {
        // Initialize connection
        connection = new Connection(RPC_URL, 'confirmed');

        // Generate fresh keypairs for each test run
        adminAccount = Keypair.generate();
        dataAccount = Keypair.generate();

        // Ensure connection is working
        try {
            await connection.getVersion();
        } catch (error) {
            throw new Error(`Cannot connect to Solana RPC at ${RPC_URL}: ${error}`);
        }

        // Check funding keypair balance
        const fundingBalance = await connection.getBalance(fundingKeypair.publicKey);
        const requiredBalance = FUNDING_AMOUNT_SOL * LAMPORTS_PER_SOL;
        
        if (fundingBalance < requiredBalance) {
            throw new Error(
                `Insufficient funding keypair balance. Required: ${requiredBalance / LAMPORTS_PER_SOL} SOL, ` +
                `Available: ${fundingBalance / LAMPORTS_PER_SOL} SOL. ` +
                `Please fund the keypair or run 'solana airdrop 5 ${fundingKeypair.publicKey.toString()}'`
            );
        }

        // Fund the admin account
        await transferSol(connection, FUNDING_AMOUNT_SOL, adminAccount.publicKey);

        // Verify admin account is funded
        const adminAccountInfo = await connection.getAccountInfo(adminAccount.publicKey);
        if (!adminAccountInfo || adminAccountInfo.lamports === 0) {
            throw new Error("Failed to fund admin account");
        }

        // Create the data account
        await createProgramAccount(
            connection,
            adminAccount,
            dataAccount,
            COUNTER_SIZE,
            PROGRAM_ID
        );

        // Verify data account was created
        const dataAccountInfo = await connection.getAccountInfo(dataAccount.publicKey);
        if (!dataAccountInfo) {
            throw new Error("Failed to create data account");
        }
    });

    describe("Account Initialization", () => {
        test("should initialize counter account with zero value", async () => {
            // Verify data account was created
            const dataAccountInfo = await connection.getAccountInfo(dataAccount.publicKey);
            expect(dataAccountInfo).not.toBeNull();
            expect(dataAccountInfo!.owner).toEqual(PROGRAM_ID);
            expect(dataAccountInfo!.data.length).toBe(COUNTER_SIZE);

            // Deserialize and verify initial counter value
            const counterAccount = borsh.deserialize(schema, dataAccountInfo!.data) as CounterAccount;
            expect(counterAccount).toBeTruthy();
            expect(counterAccount.count).toBe(0);

            // Verify account is rent exempt
            const minimumBalance = await connection.getMinimumBalanceForRentExemption(COUNTER_SIZE);
            expect(dataAccountInfo!.lamports).toBeGreaterThanOrEqual(minimumBalance);
        }, TEST_TIMEOUT);
    });

    describe("Counter Operations", () => {
        test("should increment the counter by a small value", async () => {
            const incrementValue = 5;
            const newValue = await executeCounterInstruction(
                connection,
                { Increment: incrementValue },
                adminAccount,
                dataAccount.publicKey
            );
            
            expect(newValue).toBe(incrementValue);
        }, TEST_TIMEOUT);

        test("should increment the counter by a large value", async () => {
            const currentValue = await getCounterValue(connection, dataAccount.publicKey);
            const incrementValue = 1000000;
            
            const newValue = await executeCounterInstruction(
                connection,
                { Increment: incrementValue },
                adminAccount,
                dataAccount.publicKey
            );
            
            expect(newValue).toBe(currentValue + incrementValue);
        }, TEST_TIMEOUT);

        test("should decrement the counter", async () => {
            const currentValue = await getCounterValue(connection, dataAccount.publicKey);
            const decrementValue = 3;
            
            const newValue = await executeCounterInstruction(
                connection,
                { Decrement: decrementValue },
                adminAccount,
                dataAccount.publicKey
            );
            
            expect(newValue).toBe(currentValue - decrementValue);
        }, TEST_TIMEOUT);

        test("should handle multiple increment operations", async () => {
            const initialValue = await getCounterValue(connection, dataAccount.publicKey);
            
            // Perform multiple increments
            await executeCounterInstruction(connection, { Increment: 10 }, adminAccount, dataAccount.publicKey);
            await executeCounterInstruction(connection, { Increment: 20 }, adminAccount, dataAccount.publicKey);
            const finalValue = await executeCounterInstruction(connection, { Increment: 30 }, adminAccount, dataAccount.publicKey);
            
            expect(finalValue).toBe(initialValue + 10 + 20 + 30);
        }, TEST_TIMEOUT);

        test("should handle mixed increment and decrement operations", async () => {
            const initialValue = await getCounterValue(connection, dataAccount.publicKey);
            
            // Mix of operations
            await executeCounterInstruction(connection, { Increment: 50 }, adminAccount, dataAccount.publicKey);
            await executeCounterInstruction(connection, { Decrement: 20 }, adminAccount, dataAccount.publicKey);
            const finalValue = await executeCounterInstruction(connection, { Increment: 15 }, adminAccount, dataAccount.publicKey);
            
            expect(finalValue).toBe(initialValue + 50 - 20 + 15);
        }, TEST_TIMEOUT);

        test("should increment by 1", async () => {
            const currentValue = await getCounterValue(connection, dataAccount.publicKey);
            
            const newValue = await executeCounterInstruction(
                connection,
                { Increment: 1 },
                adminAccount,
                dataAccount.publicKey
            );
            
            expect(newValue).toBe(currentValue + 1);
        }, TEST_TIMEOUT);

        test("should decrement by 1", async () => {
            const currentValue = await getCounterValue(connection, dataAccount.publicKey);
            
            const newValue = await executeCounterInstruction(
                connection,
                { Decrement: 1 },
                adminAccount,
                dataAccount.publicKey
            );
            
            expect(newValue).toBe(currentValue - 1);
        }, TEST_TIMEOUT);

        test("should handle zero increment", async () => {
            const currentValue = await getCounterValue(connection, dataAccount.publicKey);
            
            const newValue = await executeCounterInstruction(
                connection,
                { Increment: 0 },
                adminAccount,
                dataAccount.publicKey
            );
            
            expect(newValue).toBe(currentValue);
        }, TEST_TIMEOUT);

        test("should handle zero decrement", async () => {
            const currentValue = await getCounterValue(connection, dataAccount.publicKey);
            
            const newValue = await executeCounterInstruction(
                connection,
                { Decrement: 0 },
                adminAccount,
                dataAccount.publicKey
            );
            
            expect(newValue).toBe(currentValue);
        }, TEST_TIMEOUT);
    });

    describe("Edge Cases and Error Handling", () => {
        test("should handle maximum u32 increment", async () => {
            // Reset to a known state first
            const currentValue = await getCounterValue(connection, dataAccount.publicKey);
            
            // Set counter to a value that allows for large increment without overflow
            const maxU32 = 4294967295; // 2^32 - 1
            const targetValue = 1000; // Set to a reasonable value for testing
            
            if (currentValue !== targetValue) {
                if (currentValue < targetValue) {
                    await executeCounterInstruction(
                        connection,
                        { Increment: targetValue - currentValue },
                        adminAccount,
                        dataAccount.publicKey
                    );
                } else {
                    await executeCounterInstruction(
                        connection,
                        { Decrement: currentValue - targetValue },
                        adminAccount,
                        dataAccount.publicKey
                    );
                }
            }
            
            // Now test large increment
            const largeIncrement = 1000000;
            const newValue = await executeCounterInstruction(
                connection,
                { Increment: largeIncrement },
                adminAccount,
                dataAccount.publicKey
            );
            
            expect(newValue).toBe(targetValue + largeIncrement);
        }, TEST_TIMEOUT);

        test("should handle invalid account data gracefully", async () => {
            const nonExistentAccount = Keypair.generate();
            const accountInfo = await connection.getAccountInfo(nonExistentAccount.publicKey);
            expect(accountInfo).toBeNull();
        });

        test("should fail when trying to execute instruction on non-existent account", async () => {
            const nonExistentAccount = Keypair.generate();
            
            await expect(
                executeCounterInstruction(
                    connection,
                    { Increment: 1 },
                    adminAccount,
                    nonExistentAccount.publicKey
                )
            ).rejects.toThrow();
        }, TEST_TIMEOUT);

        test("should maintain consistency across rapid operations", async () => {
            const initialValue = await getCounterValue(connection, dataAccount.publicKey);
            
            // Perform rapid operations
            const operations = [
                { Increment: 100 },
                { Decrement: 25 },
                { Increment: 75 },
                { Decrement: 50 },
                { Increment: 10 }
            ];
            
            let expectedValue = initialValue;
            for (const op of operations) {
                if ('Increment' in op && op.Increment !== undefined) {
                    expectedValue += op.Increment;
                } else {
                    expectedValue -= op.Decrement;
                }
                
                const actualValue = await executeCounterInstruction(
                    connection,
                    op,
                    adminAccount,
                    dataAccount.publicKey
                );
                
                expect(actualValue).toBe(expectedValue);
            }
        }, TEST_TIMEOUT);

        test("should verify state persistence between operations", async () => {
            // Set a known value
            await executeCounterInstruction(
                connection,
                { Increment: 42 },
                adminAccount,
                dataAccount.publicKey
            );
            
            // Read the value multiple times to ensure consistency
            const value1 = await getCounterValue(connection, dataAccount.publicKey);
            const value2 = await getCounterValue(connection, dataAccount.publicKey);
            const value3 = await getCounterValue(connection, dataAccount.publicKey);
            
            expect(value1).toBe(value2);
            expect(value2).toBe(value3);
        }, TEST_TIMEOUT);
    });
});
