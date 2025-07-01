import * as borsh from "borsh";

export class CounterAccount {
    count: number;

    constructor({ count }: { count: number }) {
        this.count = count;
    }
}

export type CounterInstruction =
  | { Increment: number }
  | { Decrement: number };


export const instructionSchema: borsh.Schema = {
    enum: [
        { struct: { Increment: 'u32' } },
        { struct: { Decrement: 'u32' } }
    ]
}

export const schema: borsh.Schema = {
    struct: {
        count: 'u32'
    }
}

export const COUNTER_SIZE = borsh.serialize(schema, new CounterAccount({ count: 0 })).length;