import { describe, expect, it } from 'vitest';
import { parseScenarioSegment, resolveScenario, isScenario, SCENARIOS } from '../src/scenarios.js';

/**
 * 按模型覆盖场景语法（CONTRACT-CHANGES 2026-10-22）：
 * `<默认场景>[,<模型名子串>=<场景>]*`，按出现顺序首个命中。
 */

describe('parseScenarioSegment', () => {
  it('单场景路径保持兼容', () => {
    for (const sc of SCENARIOS) {
      const r = parseScenarioSegment(sc);
      expect(r).not.toBeNull();
      expect(r!.defaultScenario).toBe(sc);
      expect(r!.overrides).toEqual([]);
    }
  });

  it('单个覆盖：genuine,opus=fake', () => {
    const r = parseScenarioSegment('genuine,opus=fake');
    expect(r!.defaultScenario).toBe('genuine');
    expect(r!.overrides).toEqual([{ modelSubstr: 'opus', scenario: 'fake' }]);
  });

  it('多个覆盖：fast,opus=fake,gpt-6-astra=downgraded', () => {
    const r = parseScenarioSegment('fast,opus=fake,gpt-6-astra=downgraded');
    expect(r!.defaultScenario).toBe('fast');
    expect(r!.overrides).toEqual([
      { modelSubstr: 'opus', scenario: 'fake' },
      { modelSubstr: 'gpt-6-astra', scenario: 'downgraded' },
    ]);
  });

  it('URL 编码的 %2C 和 %3D', () => {
    const r = parseScenarioSegment('genuine%2Copus%3Dfake');
    expect(r!.defaultScenario).toBe('genuine');
    expect(r!.overrides).toEqual([{ modelSubstr: 'opus', scenario: 'fake' }]);
  });

  it('子串大小写不敏感（存为小写）', () => {
    const r = parseScenarioSegment('genuine,OPUS=fake');
    expect(r!.overrides[0]!.modelSubstr).toBe('opus');
  });

  it('非法：默认场景未知 → null', () => {
    expect(parseScenarioSegment('nope,opus=fake')).toBeNull();
    expect(parseScenarioSegment('nope')).toBeNull();
  });

  it('非法：覆盖场景未知 → null', () => {
    expect(parseScenarioSegment('genuine,opus=nope')).toBeNull();
  });

  it('非法：缺子串或缺场景 → null', () => {
    expect(parseScenarioSegment('genuine,=fake')).toBeNull();
    expect(parseScenarioSegment('genuine,opus=')).toBeNull();
    expect(parseScenarioSegment('genuine,opus')).toBeNull();
  });
});

describe('resolveScenario（按顺序首个命中）', () => {
  it('模型名包含子串 → 命中覆盖', () => {
    const seg = parseScenarioSegment('genuine,opus=fake')!;
    expect(resolveScenario(seg, 'claude-opus-5-5')).toBe('fake');
    expect(resolveScenario(seg, 'Claude-Opus-5.5')).toBe('fake'); // 请求模型名小写比较
  });

  it('不包含子串 → 默认场景', () => {
    const seg = parseScenarioSegment('genuine,opus=fake')!;
    expect(resolveScenario(seg, 'claude-fable-5-1')).toBe('genuine');
    expect(resolveScenario(seg, 'claude-haiku-5-5')).toBe('genuine');
  });

  it('多个覆盖按出现顺序首个命中', () => {
    const seg = parseScenarioSegment('fast,opus=fake,gpt-6-astra=downgraded')!;
    // 同时命中两个规则时取第一个
    const segAmb = parseScenarioSegment('genuine,m=fake,m=dead')!;
    expect(resolveScenario(segAmb, 'some-model')).toBe('fake');
    // 顺序不同结果不同
    const segAmb2 = parseScenarioSegment('genuine,m=dead,m=fake')!;
    expect(resolveScenario(segAmb2, 'some-model')).toBe('dead');
    // 常规多覆盖
    expect(resolveScenario(seg, 'claude-opus-5-5')).toBe('fake');
    expect(resolveScenario(seg, 'gpt-6-astra')).toBe('downgraded');
    expect(resolveScenario(seg, 'kimi-k3')).toBe('fast');
  });

  it('gemini 路径模型名同样生效', () => {
    const seg = parseScenarioSegment('genuine,flash=dead')!;
    expect(resolveScenario(seg, 'gemini-3.8-flash')).toBe('dead');
  });
});
