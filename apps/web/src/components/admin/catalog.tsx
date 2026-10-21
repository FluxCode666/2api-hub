'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminModel, AdminVendor, Announcement, VendorInput, ModelInput, ChannelProtocol, ModelModality, ModelTier } from '@hub/shared';
import { api } from '@/lib/api/client';
import { AdminTable, MutationButton, Status, DateValue, actionRowStyle } from './common';

function TextField({ name, label, value, required = false, type = 'text', readOnly = false, placeholder }: { name: string; label: string; value?: string | number | null; required?: boolean; type?: string; readOnly?: boolean; placeholder?: string }) {
  return <label className="field">{label}<input className="input" name={name} required={required} type={type} readOnly={readOnly} placeholder={placeholder} defaultValue={value ?? ''} step={type === 'number' ? 'any' : undefined} min={type === 'number' ? 0 : undefined} /></label>;
}

export function CatalogManager({ kind, models = [], vendors, announcements = [] }: { kind: 'models' | 'vendors' | 'announcements'; models?: AdminModel[]; vendors: AdminVendor[]; announcements?: Announcement[] }) {
  const [editing, setEditing] = useState<AdminModel | AdminVendor | Announcement | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const router = useRouter();
  const model = editing && 'displayName' in editing ? editing : null;
  const vendor = editing && 'modelCount' in editing ? editing : null;
  const vendorWebsite = vendor?.website ?? '';
  const vendorDescription = vendor?.description ?? '';
  const vendorSortOrder = vendor?.sortOrder;
  const announcement = editing && 'contentMd' in editing ? editing : null;
  const noun = kind === 'models' ? '模型' : kind === 'vendors' ? '厂商' : '公告';
  async function save(form: FormData) {
    setPending(true); setMessage('');
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const number = (key: string) => text(key) === '' ? null : Number(text(key));
    let body: VendorInput | ModelInput | Pick<Announcement, 'title' | 'contentMd' | 'enabled' | 'pinned'>;
    if (kind === 'models') body = {
      slug: text('slug'), displayName: text('displayName'), vendorSlug: model?.vendor.slug ?? text('vendorSlug'), family: text('family') || null,
      modality: text('modality') as ModelModality, tier: text('tier') as ModelTier, aliases: text('aliases').split(/[\n,]/).map(item => item.trim()).filter(Boolean),
      defaultProtocol: text('defaultProtocol') as ChannelProtocol, officialInputPrice: number('officialInputPrice'), officialOutputPrice: number('officialOutputPrice'),
      contextWindow: number('contextWindow'), expectedTps: number('expectedTps'), knowledgeCutoff: text('knowledgeCutoff') || null, releasedAt: text('releasedAt') || null,
      description: text('description') || null, isFeatured: form.get('isFeatured') === 'on', isActive: form.get('isActive') === 'on', sortOrder: number('sortOrder') ?? 0,
    } satisfies ModelInput;
    else if (kind === 'vendors') body = { slug: text('slug'), name: text('name'), nameZh: text('nameZh') || null, color: text('color'), iconUrl: text('iconUrl') || null,
      ...(text('website') || !vendor || 'website' in vendor ? { website: text('website') || null } : {}),
      ...(text('description') || !vendor || 'description' in vendor ? { description: text('description') || null } : {}),
      ...(number('sortOrder') !== null || !vendor ? { sortOrder: number('sortOrder') ?? 0 } : {}),
    } satisfies VendorInput;
    else body = { title: text('title'), contentMd: text('contentMd'), enabled: form.get('enabled') === 'on', pinned: form.get('pinned') === 'on' };
    try {
      await api<unknown>(`/admin/${kind}${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      setMessage(`${noun}已保存`); setEditing(undefined); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); } finally { setPending(false); }
  }
  return <div className="stack">
    <div className="row between"><p className="muted">{kind === 'models' ? '维护标准模型、官方价格与检测基准。' : kind === 'vendors' ? '维护模型提供方与展示顺序。' : '维护公告内容及展示状态。'}</p><button className="btn btn-primary" onClick={() => { setEditing(null); setMessage(''); }}>新增{noun}</button></div>
    {message && <div className="notice" role="status">{message}</div>}
    {editing !== undefined && <section className="panel stack" key={editing?.id ?? 'new'}><div className="row between"><h2>{editing ? '编辑' : '新增'}{noun}</h2><button className="btn btn-small" onClick={() => setEditing(undefined)}>取消</button></div><form action={save} className="stack">
      <div className="form-grid">
        {kind === 'models' && <>
          <TextField name="displayName" label="显示名称" value={model?.displayName} required /><TextField name="slug" label={model ? '标准模型标识（创建后固定）' : '标准模型标识'} value={model?.slug} required readOnly={Boolean(model)} />
          <label className="field">所属厂商{model ? '（创建后固定）' : ''}<select className="select" name="vendorSlug" defaultValue={model?.vendor.slug ?? vendors[0]?.slug} required disabled={Boolean(model)}>{vendors.map(item => <option key={item.id} value={item.slug}>{item.name}</option>)}</select></label>
          <TextField name="family" label="模型系列" value={model?.family} />
          <label className="field">模态<select className="select" name="modality" defaultValue={model?.modality ?? 'text'}>{['text', 'image', 'video', 'audio', 'embedding'].map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="field">级别<select className="select" name="tier" defaultValue={model?.tier ?? 'standard'}><option value="flagship">旗舰</option><option value="standard">标准</option><option value="lite">轻量</option></select></label>
          <label className="field">默认协议<select className="select" name="defaultProtocol" defaultValue={model?.defaultProtocol ?? 'openai_chat'}>{['openai_chat', 'openai_responses', 'anthropic', 'gemini'].map(value => <option key={value}>{value}</option>)}</select></label>
          <TextField name="officialInputPrice" label="官方输入价（$/百万 Token）" value={model?.officialInputPrice} type="number" /><TextField name="officialOutputPrice" label="官方输出价（$/百万 Token）" value={model?.officialOutputPrice} type="number" />
          <TextField name="contextWindow" label="上下文窗口（Token）" value={model?.contextWindow} type="number" /><TextField name="expectedTps" label="预期输出速度（Token/秒）" value={model?.expectedTps} type="number" /><TextField name="knowledgeCutoff" label="知识截止（YYYY-MM）" value={model?.knowledgeCutoff} /><TextField name="releasedAt" label="发布日期" value={model?.releasedAt} type="date" />
          <TextField name="sortOrder" label="排序权重" value={model?.sortOrder ?? 0} type="number" />
          <label className="field">上游别名（逗号分隔）<input className="input" name="aliases" defaultValue={model?.aliases.join(', ')} /></label>
          <label className="row"><input type="checkbox" name="isFeatured" defaultChecked={model?.isFeatured ?? false} />首页精选</label><label className="row"><input type="checkbox" name="isActive" defaultChecked={model?.isActive ?? true} />启用模型</label>
        </>}
        {kind === 'vendors' && <><TextField name="name" label="厂商名称" value={vendor?.name} required /><TextField name="slug" label={vendor ? '厂商标识（创建后固定）' : '厂商标识'} value={vendor?.slug} required readOnly={Boolean(vendor)} /><TextField name="nameZh" label="中文名称" value={vendor?.nameZh} /><TextField name="color" label="品牌颜色" value={vendor?.color ?? '#bbf49a'} type="color" /><TextField name="iconUrl" label="品牌图标网址" type="url" value={vendor?.iconUrl} /><TextField name="website" label="官方网站" type="url" value={vendorWebsite} placeholder={vendor && !('website' in vendor) ? '留空保持现有网址' : undefined} /><TextField name="sortOrder" label="排序权重" type="number" value={vendor ? vendorSortOrder : 0} placeholder={vendor && vendorSortOrder === undefined ? '留空保持现有顺序' : undefined} /></>}
        {kind === 'announcements' && <><TextField name="title" label="公告标题" value={announcement?.title} required /><label className="row"><input type="checkbox" name="enabled" defaultChecked={announcement?.enabled ?? true} />发布公告</label><label className="row"><input type="checkbox" name="pinned" defaultChecked={announcement?.pinned ?? false} />置顶展示</label></>}
      </div>
      <label className="field">{kind === 'announcements' ? '公告内容（Markdown）' : '描述'}<textarea className="input" rows={5} name={kind === 'announcements' ? 'contentMd' : 'description'} required={kind === 'announcements'} placeholder={vendor && !('description' in vendor) ? '留空保持现有描述' : undefined} defaultValue={announcement?.contentMd ?? model?.description ?? vendorDescription} /></label>
      <div><button className="btn btn-primary" disabled={pending}>{pending ? '正在保存…' : '保存'}</button></div>
    </form></section>}
    {kind === 'models' && <AdminTable items={models} searchText={item => `${item.displayName} ${item.slug} ${item.vendor.name}`} statusOf={item => String(item.isActive)} statuses={[{ value: 'true', label: '已启用' }, { value: 'false', label: '已停用' }]} columns={[
      { label: '模型', render: item => <><div>{item.displayName}</div><div className="mono muted">{item.slug}</div></> }, { label: '厂商 / 级别', render: item => <>{item.vendor.name}<div className="muted">{item.tier} · {item.modality}</div></> },
      { label: '官方输入 / 输出（$/M）', render: item => <span className="mono">{item.officialInputPrice ?? '—'} / {item.officialOutputPrice ?? '—'}</span> }, { label: '状态', render: item => <Status value={item.isActive ? 'active' : 'paused'} /> }, { label: '操作', render: item => <div style={actionRowStyle}><button className="btn btn-small" onClick={() => setEditing(item)}>编辑</button><MutationButton path={`/admin/models/${item.id}`} method="DELETE" confirmation={`确定删除模型 ${item.displayName}？`}>删除</MutationButton></div> },
    ]} />}
    {kind === 'vendors' && <AdminTable items={vendors} searchText={item => `${item.name} ${item.nameZh ?? ''} ${item.slug}`} columns={[
      { label: '厂商', render: item => <><div>{item.name}</div><div className="muted">{item.nameZh ?? item.slug}</div></> }, { label: '标准标识', render: item => <span className="mono">{item.slug}</span> }, { label: '模型 / 渠道', render: item => <span className="mono">{item.modelCount} / {item.channelCount}</span> }, { label: '操作', render: item => <div style={actionRowStyle}><button className="btn btn-small" onClick={() => setEditing(item)}>编辑</button><MutationButton path={`/admin/vendors/${item.id}`} method="DELETE" confirmation={`确定删除厂商 ${item.name}？仍被模型引用的厂商无法删除。`}>删除</MutationButton></div> },
    ]} />}
    {kind === 'announcements' && <AdminTable items={announcements} searchText={item => `${item.title} ${item.contentMd}`} statusOf={item => String(item.enabled)} statuses={[{ value: 'true', label: '已发布' }, { value: 'false', label: '已停用' }]} columns={[
      { label: '公告', render: item => <><div>{item.title} {item.pinned && <span className="badge">置顶</span>}</div><div className="muted" style={{ whiteSpace: 'normal', maxWidth: 480 }}>{item.contentMd.slice(0, 150)}</div></> }, { label: '状态', render: item => <Status value={item.enabled ? 'visible' : 'hidden'} /> }, { label: '发布时间', render: item => <DateValue value={item.createdAt} /> }, { label: '操作', render: item => <div style={actionRowStyle}><button className="btn btn-small" onClick={() => setEditing(item)}>编辑</button><MutationButton path={`/admin/announcements/${item.id}`} body={{ enabled: !item.enabled }}>{item.enabled ? '停用' : '发布'}</MutationButton><MutationButton path={`/admin/announcements/${item.id}`} method="DELETE" confirmation={`确定删除公告「${item.title}」？`}>删除</MutationButton></div> },
    ]} />}
  </div>;
}
