import type { SessionNotification } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { acpChatSessionActions, acpChatSessionStore } from '../chatSessionStore';
import type { Session } from '../../types/session';

const SID = 'stab-session';

function agentChunk(messageId: string, text: string): SessionNotification {
  return { sessionId: SID, update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } } };
}
function userChunk(messageId: string, text: string): SessionNotification {
  return { sessionId: SID, update: { sessionUpdate: 'user_message_chunk', messageId, content: { type: 'text', text } } };
}
function finish() {
  acpChatSessionActions.finishSessionLoad(SID, { id: SID, name: 't', working_dir: '/tmp', conversation: [], message_count: 0, extension_data: {}, source: 'test' } as unknown as Session);
}

function byId(snap: ReturnType<typeof acpChatSessionStore.getSnapshot>, id: string) {
  return snap?.messages.find((m) => m.id === id);
}

describe('snapshot reference stability (render optimization)', () => {
  it('historical messages keep stable references while a new prompt streams', () => {
    acpChatSessionActions.startSessionLoad(SID);
    acpChatSessionActions.applyAcpSessionNotification(agentChunk('hist-1', 'answer one'));
    acpChatSessionActions.applyAcpSessionNotification(agentChunk('hist-2', 'answer two'));
    acpChatSessionActions.applyAcpSessionNotification(agentChunk('hist-3', 'answer three'));
    finish();

    const baseline = acpChatSessionStore.getSnapshot(SID)!;
    expect(baseline.messages.length).toBe(3);
    const hist1Ref = byId(baseline, 'hist-1');
    const hist2Ref = byId(baseline, 'hist-2');

    // Simulate a new prompt turn: user msg + streaming agent reply (3 chunks)
    acpChatSessionActions.applyAcpSessionNotification(userChunk('user-1', 'question?'));
    const afterUser = acpChatSessionStore.getSnapshot(SID)!;
    acpChatSessionActions.applyAcpSessionNotification(agentChunk('agent-1', 'Hel'));
    const afterChunk1 = acpChatSessionStore.getSnapshot(SID)!;
    acpChatSessionActions.applyAcpSessionNotification(agentChunk('agent-1', 'lo')); // appends to same msg
    const afterChunk2 = acpChatSessionStore.getSnapshot(SID)!;
    acpChatSessionActions.applyAcpSessionNotification(agentChunk('agent-1', ' world'));
    const afterChunk3 = acpChatSessionStore.getSnapshot(SID)!;

    // Historical messages: SAME reference across all snapshots (memo can skip)
    expect(byId(afterUser, 'hist-1')).toBe(hist1Ref);
    expect(byId(afterChunk1, 'hist-1')).toBe(hist1Ref);
    expect(byId(afterChunk2, 'hist-1')).toBe(hist1Ref);
    expect(byId(afterChunk3, 'hist-1')).toBe(hist1Ref);
    expect(byId(afterChunk3, 'hist-2')).toBe(hist2Ref);

    // Streaming message: reference CHANGES as content grows (memo re-renders)
    expect((byId(afterChunk1, 'agent-1')?.content[0] as { text: string }).text).toBe('Hel');
    expect((byId(afterChunk2, 'agent-1')?.content[0] as { text: string }).text).toBe('Hello');
    expect((byId(afterChunk3, 'agent-1')?.content[0] as { text: string }).text).toBe('Hello world');
    // Different reference each chunk (content changed)
    expect(byId(afterChunk1, 'agent-1')).not.toBe(byId(afterChunk3, 'agent-1'));
  });
});
