'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { PROTOCOL_LABELS, SITE_TYPE_LABELS, PAYMENT_METHOD_LABELS } from '@hub/shared';
import type { ChannelInput, MerchantChannel, MerchantSite, ModelSummary, SiteInput, SiteType, VendorSummary, ChannelProtocol, BillingType } from '@hub/shared';

export function errorMessage(error: unknown) { return error instanceof Error ? error.message : '操作失败，请稍后重试'; }
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>; }
const text = (data: FormData, name: string) => String(data.get(name) ?? '').trim();
const optional = (data: FormData, name: string) => text(data, name) || null;
const numberOrNull = (data: FormData, name: string) => text(data, name) ? Number(data.get(name)) : null;
const list = (data: FormData, name: string) => text(data, name).split(/[,，\n]/).map((v) => v.trim()).filter(Boolean);

export function SiteForm({ site, onSave, submitLabel = '保存站点' }: { site?: MerchantSite; onSave: (input: SiteInput) => Promise<void>; submitLabel?: string }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError('');
    const contact = Object.fromEntries(['email', 'qq', 'wechat', 'telegram', 'group'].flatMap((key) => text(data, key) ? [[key, text(data, key)]] : []));
    const input: SiteInput = { name: text(data, 'name'), homepageUrl: text(data, 'homepageUrl'), inviteUrl: optional(data, 'inviteUrl'), logoUrl: optional(data, 'logoUrl'), description: optional(data, 'description'), type: text(data, 'type') as SiteType, rechargeRatio: Number(data.get('rechargeRatio')), contact, tags: list(data, 'tags'), paymentMethods: data.getAll('paymentMethods').map(String) };
    if (!site && text(data, 'slug')) input.slug = text(data, 'slug');
    try { await onSave(input); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <form className="stack" onSubmit={submit}>
    <div className="form-grid">
      <Field label="站点名称"><input className="input" name="name" defaultValue={site?.name} placeholder="你的中转站名称" required maxLength={80} /></Field>
      <Field label="站点类型"><select className="select" name="type" defaultValue={site?.type ?? 'new_api'}>{Object.entries(SITE_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="官网地址"><input className="input" name="homepageUrl" type="url" defaultValue={site?.homepageUrl} placeholder="https://example.com" required /></Field>
      <Field label="邀请链接（可选）"><input className="input" name="inviteUrl" type="url" defaultValue={site?.inviteUrl ?? ''} placeholder="https://example.com/register?aff=..." /></Field>
      {!site && <Field label="站点标识（可选）" hint="用于公开档案网址，留空将自动生成。"><input className="input" name="slug" pattern="[a-z0-9-]+" placeholder="my-api" /></Field>}
      <Field label="充值倍率" hint="每充值 ¥1 获得多少美元额度。例如 ¥1 = $1 额度，填 1。"><input className="input mono" name="rechargeRatio" type="number" min="0.000001" step="any" defaultValue={site?.rechargeRatio ?? 1} required /></Field>
      <Field label="Logo 地址（可选）"><input className="input" name="logoUrl" type="url" defaultValue={site?.logoUrl ?? ''} placeholder="https://example.com/logo.png" /></Field>
      <Field label="标签" hint="使用逗号分隔。"><input className="input" name="tags" defaultValue={site?.tags.join(', ')} placeholder="企业服务, 支持开票" /></Field>
    </div>
    <Field label="站点简介"><textarea className="input" name="description" defaultValue={site?.description ?? ''} placeholder="说明渠道来源、服务特点和适用人群" rows={3} maxLength={2000} /></Field>
    <fieldset className="merchant-fieldset"><legend>联系方式</legend><div className="form-grid">
      <Field label="联系邮箱"><input className="input" name="email" type="email" defaultValue={site?.contact.email} placeholder="support@example.com" /></Field>
      <Field label="Telegram"><input className="input" name="telegram" defaultValue={site?.contact.telegram} placeholder="@username" /></Field>
      <Field label="QQ"><input className="input" name="qq" defaultValue={site?.contact.qq} /></Field>
      <Field label="微信"><input className="input" name="wechat" defaultValue={site?.contact.wechat} /></Field>
      <Field label="交流群"><input className="input" name="group" defaultValue={site?.contact.group} /></Field>
    </div></fieldset>
    <fieldset className="merchant-fieldset"><legend>支付方式</legend><div className="merchant-checks">{Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => <label key={value}><input type="checkbox" name="paymentMethods" value={value} defaultChecked={site?.paymentMethods.includes(value)} /> {label}</label>)}</div></fieldset>
    {error && <div role="alert" className="notice notice-error">{error}</div>}
    <div className="row"><button className="btn btn-primary" disabled={busy} type="submit">{busy ? '正在保存…' : submitLabel}</button></div>
  </form>;
}

export function ChannelForm({ channel, vendors, models, onSave, submitLabel = '保存渠道' }: { channel?: MerchantChannel; vendors: VendorSummary[]; models: ModelSummary[]; onSave: (input: ChannelInput) => Promise<void>; submitLabel?: string }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); setBusy(true); setError('');
    const input: ChannelInput = { name: text(data, 'name'), description: optional(data, 'description'), vendorSlug: optional(data, 'vendorSlug'), protocol: text(data, 'protocol') as ChannelProtocol, baseUrl: text(data, 'baseUrl'), groupRatio: Number(data.get('groupRatio')), billingType: text(data, 'billingType') as BillingType, primaryModel: text(data, 'primaryModel'), backupModel: optional(data, 'backupModel'), rpmLimit: numberOrNull(data, 'rpmLimit') };
    if (!channel) input.declaredModels = list(data, 'declaredModels');
    if (text(data, 'apiKey')) input.apiKey = text(data, 'apiKey');
    try { await onSave(input); if (!channel) form.reset(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <form className="stack" onSubmit={submit}>
    <div className="form-grid">
      <Field label="渠道 / 分组名称"><input className="input" name="name" defaultValue={channel?.name} placeholder="例如 Claude 官方渠道" required /></Field>
      <Field label="主要厂商"><select className="select" name="vendorSlug" defaultValue={channel?.vendor?.slug ?? ''}><option value="">多厂商 / 未指定</option>{vendors.map((v) => <option value={v.slug} key={v.slug}>{v.nameZh ?? v.name}</option>)}</select></Field>
      <Field label="API 协议"><select className="select" name="protocol" defaultValue={channel?.protocol ?? 'openai_chat'}>{Object.entries(PROTOCOL_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
      <Field label="接口地址"><input className="input mono" name="baseUrl" type="url" defaultValue={channel?.baseUrl} placeholder="https://api.example.com" required /></Field>
      <Field label={channel ? '更新检测密钥（可选）' : '检测用 API Key'} hint={channel ? `当前 ${channel.apiKeyMask}；留空保留原密钥。` : '仅用于平台检测，请使用独立、限额的测试密钥。'}><input className="input mono" name="apiKey" type="password" autoComplete="new-password" placeholder={channel ? '留空不修改' : 'sk-...'} required={!channel} /></Field>
      <Field label="分组倍率" hint="实际倍率 = 分组倍率 ÷ 站点充值倍率。"><input className="input mono" name="groupRatio" type="number" step="any" min="0.000001" defaultValue={channel?.groupRatio ?? 1} required /></Field>
      <Field label="主测模型"><input className="input mono" name="primaryModel" list="merchant-models" defaultValue={channel?.primaryModel} placeholder="上游模型 ID" required /></Field>
      <Field label="备用模型（可选）"><input className="input mono" name="backupModel" list="merchant-models" defaultValue={channel?.backupModel ?? ''} /></Field>
      <Field label="计费方式"><select className="select" name="billingType" defaultValue={channel?.billingType ?? 'per_token'}><option value="per_token">按 Token</option><option value="per_request">按次</option><option value="subscription">订阅</option></select></Field>
      <Field label="每分钟请求上限（可选）"><input className="input mono" name="rpmLimit" type="number" min="1" step="1" defaultValue={channel?.rpmLimit ?? ''} /></Field>
    </div>
    <datalist id="merchant-models">{models.map((m) => <option key={m.slug} value={m.slug}>{m.displayName}</option>)}</datalist>
    {!channel ? <Field label="声明模型列表" hint="每行一个上游模型名，也可以使用逗号分隔。之后可从接口获取模型列表。"><textarea className="input mono" name="declaredModels" rows={4} /></Field> : <p className="muted merchant-small">模型列表、目录映射与覆盖价请在下方「模型映射与价格」中统一维护。</p>}
    <Field label="渠道说明"><textarea className="input" name="description" defaultValue={channel?.description ?? ''} rows={2} /></Field>
    {error && <div role="alert" className="notice notice-error">{error}</div>}
    <div className="row"><button className="btn btn-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : submitLabel}</button></div>
  </form>;
}
