use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{AccountInfo, next_account_info},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    pubkey::Pubkey,
};

#[derive(BorshSerialize, BorshDeserialize)]
enum Instructions {
    Increment(u32),
    Decrement(u32)
}

#[derive(BorshDeserialize, BorshSerialize)]
struct Counter {
    count: u32
}

entrypoint!(process_instructions);

pub fn process_instructions(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let acc = next_account_info(&mut accounts.iter())?;
    let instruction = Instructions::try_from_slice(instruction_data)?;
    let mut counter_data = Counter::try_from_slice(&acc.data.borrow())?;

    match instruction {
        Instructions::Increment(value) => counter_data.count += value,
        Instructions::Decrement(value) => counter_data.count -= value
    }

    counter_data.serialize(&mut *acc.data.borrow_mut())?;

    msg!("Counter updated to {}", counter_data.count);
    Ok(())
}
