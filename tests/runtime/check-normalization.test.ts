import { describe, expect, test } from 'bun:test';
import {
  classifyVerificationOutcome,
  markSupersededOutcome,
  normalizeCheckId,
  normalizeCheckIds,
  reconcileVerificationHistory,
  validateCheckIdAgainstRegistry,
} from '../../src/runtime/control-plane/facade/check-normalization';

const registry = [
  { id: 'package:check:type' },
  { id: 'package:test' },
  { id: 'package:lint' },
];

describe('check normalization and verification pollution', () => {
  test('normalizeCheckId maps aliases to registered ids', () => {
    expect(normalizeCheckId('typecheck', registry)).toBe('package:check:type');
    expect(normalizeCheckId('package:test', registry)).toBe('package:test');
    expect(normalizeCheckId('docs', registry)).toBeUndefined();
  });

  test('validateCheckIdAgainstRegistry separates invalid ids', () => {
    expect(validateCheckIdAgainstRegistry('type', registry)).toMatchObject({
      valid: true,
      normalizedCheckId: 'package:check:type',
    });
    expect(validateCheckIdAgainstRegistry('not-a-real-check', registry)).toMatchObject({
      valid: false,
    });
  });

  test('normalizeCheckIds only suggests real registered check ids', () => {
    const result = normalizeCheckIds(['typecheck', 'docs', 'lint'], registry);
    expect(result.validCheckIds).toEqual(['package:check:type', 'package:lint']);
    expect(result.invalidCheckIds).toEqual(['docs']);
    expect(result.suggestedNextActions.every((action) => action.payload?.check_id && result.validCheckIds.includes(String(action.payload.check_id)))).toBe(true);
  });

  test('invalid_check_id is not acceptance failure', () => {
    const classified = classifyVerificationOutcome({
      checkId: 'docs',
      available: registry,
      checkFailed: true,
    });
    expect(classified.outcome).toBe('invalid_check_id');
    expect(classified.isAcceptanceFailure).toBe(false);
    expect(classified.isInfrastructureIssue).toBe(true);
  });

  test('infrastructure_failure is not acceptance failure', () => {
    const classified = classifyVerificationOutcome({
      checkId: 'package:test',
      available: registry,
      infrastructureFailed: true,
    });
    expect(classified.outcome).toBe('infrastructure_failure');
    expect(classified.isAcceptanceFailure).toBe(false);
    expect(classified.isInfrastructureIssue).toBe(true);
  });

  test('valid_fail is acceptance failure; valid_pass is not', () => {
    expect(classifyVerificationOutcome({
      checkId: 'package:test',
      available: registry,
      checkFailed: true,
    })).toMatchObject({ outcome: 'valid_fail', isAcceptanceFailure: true });

    expect(classifyVerificationOutcome({
      checkId: 'package:check:type',
      available: registry,
    })).toMatchObject({ outcome: 'valid_pass', isAcceptanceFailure: false });
  });

  test('later valid_pass supersedes prior invalid_check_id noise', () => {
    const history = reconcileVerificationHistory([
      { checkId: 'package:check:type', outcome: 'invalid_check_id', recordedAt: '2026-07-09T00:00:00.000Z' },
      { checkId: 'package:check:type', outcome: 'valid_pass', recordedAt: '2026-07-09T00:01:00.000Z' },
      { checkId: 'package:test', outcome: 'infrastructure_failure', recordedAt: '2026-07-09T00:00:30.000Z' },
    ]);
    expect(history.validPasses).toContain('package:check:type');
    expect(history.invalidCheckIds).not.toContain('package:check:type');
    expect(history.infrastructureIssues).toContain('package:test');
    expect(history.acceptanceFailures).toEqual([]);
    expect(markSupersededOutcome('invalid_check_id')).toBe('superseded');
  });
});
