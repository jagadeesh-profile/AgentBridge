// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnerClient, PendingTask } from '@agentbridge/sdk/owner';
import { Board } from './board.js';

/**
 * The task board, rendered.
 *
 * This file exists because the PR description claimed the board's
 * `include_payload=false` guarantee had been "checked by asserting the payload
 * text is absent from the page, not just from a unit-test response" — and the
 * only artifact in the repo was exactly that unit-test response
 * (`hub/src/http/app.test.ts`). The page-level check had been done by hand in
 * a session that left nothing behind. Verifying the claim before repeating it
 * is what produced these tests.
 *
 * The API-level assertion is still the one that matters most, because it is
 * what stops the bytes reaching the browser at all. These cover the half it
 * cannot: that the component does not render a payload even when handed one.
 */

afterEach(cleanup);

/**
 * A client with only the methods these tests exercise.
 *
 * `base` is annotated `Partial<OwnerClient>` deliberately. The final cast has
 * to be `as unknown as OwnerClient` because the stub is incomplete, and that
 * cast erases every type error inside the object literal — a stub returning
 * the wrong shape would compile and the test would assert against a fiction.
 * Checking the literal against `Partial<OwnerClient>` first keeps the cast's
 * blast radius to "methods are missing" rather than "methods are wrong".
 */
function stubClient(over: Partial<OwnerClient> = {}): OwnerClient {
  const base: Partial<OwnerClient> = {
    cancelTask: vi.fn(() => Promise.resolve({ id: 'tsk_01', state: 'canceled' })),
  };
  return { ...base, ...over } as unknown as OwnerClient;
}

const SECRET = 'wire-50000-to-account-746251';

function task(over: Partial<PendingTask> = {}): PendingTask {
  return {
    id: 'tsk_01',
    title: 'pay the invoice',
    creator: 'agent:claude',
    assignee: 'agent:muse',
    state: 'working',
    sideEffect: false,
    payloadHash: 'f'.repeat(64),
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T11:00:00.000Z',
    ...over,
  } as PendingTask;
}

describe('Board — payloads never reach the page', () => {
  it('renders no payload text even when a task carries one', async () => {
    // The hub is asked for `include_payload=false`, so in production `payload`
    // is absent. Handing one in anyway is the point: if the board ever starts
    // rendering payloads, a change to the query string is all that stands
    // between a side-effect body and the screen. This fails if the component
    // acquires `{task.payload}` or a debug `JSON.stringify(task)`.
    render(
      <Board
        client={stubClient()}
        tasks={[task({ payload: { instruction: SECRET } } as Partial<PendingTask>)]}
        onChanged={vi.fn()}
      />,
    );

    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain('746251');
    // …while still showing what the board is for.
    expect(screen.getByText('pay the invoice')).toBeDefined();
  });

  it('shows the title, id and participants, so the omission is not just a blank page', async () => {
    // Guards the test above from passing vacuously: a board that rendered
    // nothing at all would also contain no payload.
    render(<Board client={stubClient()} tasks={[task()]} onChanged={vi.fn()} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('pay the invoice');
    expect(text).toContain('tsk_01');
    expect(text).toContain('agent:claude');
    expect(text).toContain('agent:muse');
  });
});

describe('Board — grouping and cancellation', () => {
  it('groups tasks by state and counts each column', () => {
    render(
      <Board
        client={stubClient()}
        tasks={[
          task({ id: 'tsk_a', state: 'working', title: 'a' }),
          task({ id: 'tsk_b', state: 'working', title: 'b' }),
          task({ id: 'tsk_c', state: 'completed', title: 'c' }),
        ]}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText('Working').parentElement?.textContent).toContain('2');
    expect(screen.getByText('Completed').parentElement?.textContent).toContain('1');
  });

  it('offers no Cancel on a task already in a terminal state', () => {
    // Cancelling a completed task is a transition the hub refuses; offering
    // the button invites an error the owner cannot act on.
    render(
      <Board client={stubClient()} tasks={[task({ state: 'completed' })]} onChanged={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('offers Cancel on a live task and calls the client with its id', async () => {
    const cancelTask = vi.fn(() => Promise.resolve({ id: 'tsk_live', state: 'canceled' }));
    const onChanged = vi.fn();
    render(
      <Board
        client={stubClient({ cancelTask })}
        tasks={[task({ id: 'tsk_live', state: 'working' })]}
        onChanged={onChanged}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelTask).toHaveBeenCalledWith('tsk_live');
    expect(onChanged).toHaveBeenCalled();
  });

  it('reports a failed cancel instead of silently doing nothing', async () => {
    const cancelTask = vi.fn(() => Promise.reject({ code: 'illegal_transition' }));
    render(
      <Board
        client={stubClient({ cancelTask })}
        tasks={[task({ state: 'working' })]}
        onChanged={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.body.textContent).toContain('illegal_transition');
  });

  it('marks a side-effect task, since that is what the gate holds', () => {
    render(
      <Board
        client={stubClient()}
        tasks={[task({ sideEffect: true, state: 'needs-approval' })]}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText('side effect')).toBeDefined();
  });
});
