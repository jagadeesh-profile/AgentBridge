// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSummary, OwnerClient } from '@agentbridge/sdk/owner';
import { Agents } from './agents.js';

/**
 * The kill switch, rendered.
 *
 * Revoking has no undo in Phase 0 — the agent must be re-enrolled with a fresh
 * key — so the component asks the owner to type the agent's name rather than
 * accepting a single click. That guard is UI-only: the hub will happily revoke
 * on one signed request, so nothing but these tests holds it in place.
 */

afterEach(cleanup);

function stubClient(over: Partial<OwnerClient> = {}): OwnerClient {
  return {
    revokeAgentKey: vi.fn(() => Promise.resolve({ revoked: 'agent:muse' })),
    ...over,
  } as unknown as OwnerClient;
}

function agent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    ref: 'agent:muse',
    name: 'muse',
    scopes: ['read', 'message'],
    keyStatus: 'active',
    webhookUrl: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    ...over,
  } as AgentSummary;
}

describe('Agents — the typed-name guard', () => {
  it('does not revoke on the first click; it asks for confirmation', async () => {
    const revokeAgentKey = vi.fn(() => Promise.resolve({ revoked: 'agent:muse' }));
    render(
      <Agents client={stubClient({ revokeAgentKey })} agents={[agent()]} onChanged={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Revoke key' }));

    expect(revokeAgentKey).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('cannot be undone');
  });

  it('keeps the confirm button DISABLED until the name matches exactly', async () => {
    render(<Agents client={stubClient()} agents={[agent()]} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke key' }));

    const confirm = screen.getByRole('button', { name: 'Revoke agent:muse' });
    expect(confirm).toHaveProperty('disabled', true);

    // A prefix is not enough — this is the misclick the guard exists for.
    await userEvent.type(screen.getByRole('textbox'), 'mus');
    expect(confirm).toHaveProperty('disabled', true);

    await userEvent.type(screen.getByRole('textbox'), 'e');
    expect(confirm).toHaveProperty('disabled', false);
  });

  it('rejects a near-miss: the ref is not the name', async () => {
    // `agent:muse` is what the button says it will revoke, but `name` is what
    // must be typed. Accepting the ref would make the prompt inconsistent with
    // its own instruction.
    render(<Agents client={stubClient()} agents={[agent()]} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke key' }));
    await userEvent.type(screen.getByRole('textbox'), 'agent:muse');
    expect(screen.getByRole('button', { name: 'Revoke agent:muse' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('revokes by REF once the name is typed, not by the typed name', async () => {
    // The typed text is a confirmation, not an identifier. Revoking whatever
    // was typed would be a different and much worse API call.
    const revokeAgentKey = vi.fn(() => Promise.resolve({ revoked: 'agent:muse' }));
    const onChanged = vi.fn();
    render(
      <Agents client={stubClient({ revokeAgentKey })} agents={[agent()]} onChanged={onChanged} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Revoke key' }));
    await userEvent.type(screen.getByRole('textbox'), 'muse');
    await userEvent.click(screen.getByRole('button', { name: 'Revoke agent:muse' }));

    expect(revokeAgentKey).toHaveBeenCalledWith('agent:muse');
    expect(onChanged).toHaveBeenCalled();
  });

  it('abandons the confirmation on Cancel without revoking', async () => {
    const revokeAgentKey = vi.fn(() => Promise.resolve({ revoked: 'agent:muse' }));
    render(
      <Agents client={stubClient({ revokeAgentKey })} agents={[agent()]} onChanged={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Revoke key' }));
    await userEvent.type(screen.getByRole('textbox'), 'muse');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(revokeAgentKey).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Revoke key' })).toBeDefined();
  });

  it('clears the typed text when confirmation is reopened', async () => {
    // Otherwise a previously typed name would leave the confirm button live
    // for the NEXT agent the owner opens — a one-click revoke of the wrong one.
    render(
      <Agents
        client={stubClient()}
        agents={[agent(), agent({ ref: 'agent:claude', name: 'claude' })]}
        onChanged={vi.fn()}
      />,
    );
    const [museBtn, claudeBtn] = screen.getAllByRole('button', { name: 'Revoke key' });
    await userEvent.click(museBtn as HTMLElement);
    await userEvent.type(screen.getByRole('textbox'), 'muse');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(claudeBtn as HTMLElement);

    expect(screen.getByRole('textbox')).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: 'Revoke agent:claude' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('Agents — revoked state and failures', () => {
  it('offers no revoke button for a key already revoked', () => {
    render(
      <Agents
        client={stubClient()}
        agents={[agent({ keyStatus: 'revoked' })]}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Revoke key' })).toBeNull();
    expect(document.body.textContent).toContain('key revoked');
  });

  it('surfaces a failed revoke rather than appearing to succeed', async () => {
    // The owner must not be left believing an agent is stopped when it is not.
    const revokeAgentKey = vi.fn(() => Promise.reject(new Error('owner signature rejected')));
    const onChanged = vi.fn();
    render(
      <Agents client={stubClient({ revokeAgentKey })} agents={[agent()]} onChanged={onChanged} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Revoke key' }));
    await userEvent.type(screen.getByRole('textbox'), 'muse');
    await userEvent.click(screen.getByRole('button', { name: 'Revoke agent:muse' }));

    expect(document.body.textContent).toContain('owner signature rejected');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows scopes, so least privilege is visible rather than assumed', () => {
    render(<Agents client={stubClient()} agents={[agent()]} onChanged={vi.fn()} />);
    expect(document.body.textContent).toContain('read, message');
  });

  it('says so when a workspace has no agents', () => {
    render(<Agents client={stubClient()} agents={[]} onChanged={vi.fn()} />);
    expect(document.body.textContent).toContain('No agents registered');
  });
});
