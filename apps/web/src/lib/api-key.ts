import type {FormEvent, InvalidEvent} from 'react';

export const API_KEY_LENGTH_ERROR = 'API Key 长度至少 8 位';

// 留空的编辑字段表示保留原 Key；新建和鉴定由 required 约束。
export const apiKeyInputValidation = {
  minLength: 8,
  maxLength: 500,
  onInvalid(event: InvalidEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    if (input.validity.tooShort || input.validity.valueMissing) {
      input.setCustomValidity(API_KEY_LENGTH_ERROR);
    }
  },
  onInput(event: FormEvent<HTMLInputElement>) {
    event.currentTarget.setCustomValidity('');
  },
};

export function apiKeyTooShort(value: string, optional = false): boolean {
  return !(optional && value.length === 0) && value.length < 8;
}
