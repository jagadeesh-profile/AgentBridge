import { Agent, type AgentOptions } from '@agentbridge/sdk';
import { museHandler } from '../handler.js';

export interface StubMuse {
  /** Drives one polling pass. Returns how many items were handled. */
  poll: () => Promise<number>;
  stop: () => void;
  handled: () => number;
}

/**
 * Mode 1 of 3: Muse runs a process and uses the SDK handler.
 * The hub pushes nothing here; the Agent polls and acks.
 */
export function startSdkMuse(opts: AgentOptions): StubMuse {
  const agent = new Agent(opts);
  let handled = 0;
  let sawGatedTask = false;

  agent.onTask((delivery) => {
    // A task still waiting for approval must never reach Muse. If one ever
    // does, that is the approval gate failing, and the pilot should fail loudly
    // rather than quietly do the work.
    const state = (delivery.payload.unwrap() as { state?: unknown } | null)?.state;
    if (state === 'needs-approval') {
      sawGatedTask = true;
      throw new Error('received a task still awaiting approval');
    }
    handled += 1;
    return museHandler(delivery.payload);
  });

  return {
    poll: () => agent.poll(),
    stop: () => agent.stop(),
    handled: () => {
      if (sawGatedTask) throw new Error('the approval gate leaked a gated task');
      return handled;
    },
  };
}
