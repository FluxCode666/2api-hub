'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { PlusIcon, PencilSimpleIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import type { AdminModel, AdminVendor, Announcement, VendorInput, ModelInput } from '@hub/shared';
import { PROTOCOL_LABELS } from '@hub/shared';
import { apiWithHeaders, apiNoticeMessage } from '@/lib/api/client';
import { paginationValues, slicePage } from '@/lib/pagination';
import { searchString, type SearchValues } from '@/lib/query';
import { themes } from '@/lib/theme';
import { DataPagination } from '@/components/data-pagination';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Form } from '@/components/ui/form';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AdminTable, MutationButton, Status, DateValue } from './common';
import { AdminFilters } from './filters';
import { AdminInput, AdminSelect, AdminSwitch, AdminTextarea, numberText, optionalNumber, splitValues, urlText } from './form-fields';

type Kind = 'models' | 'vendors' | 'announcements';
type Editable = AdminModel | AdminVendor | Announcement;
const tierLabels = { flagship: '旗舰', standard: '标准', lite: '轻量' };
const modalityLabels = { text: '文本', image: '图像', video: '视频', audio: '音频', embedding: '嵌入' };
const catalogSchema = z.object({
  kind: z.enum(['models', 'vendors', 'announcements']), slug: z.string().max(100), name: z.string().max(100), nameZh: z.string().max(100), color: z.string(), iconUrl: urlText('图标网址'), website: urlText('官网网址'),
  displayName: z.string().max(100, '显示名称最多 100 个字符'), vendorSlug: z.string().max(50), family: z.string().max(50, '模型系列最多 50 个字符'), modality: z.enum(['text', 'image', 'video', 'audio', 'embedding']), tier: z.enum(['flagship', 'standard', 'lite']),
  defaultProtocol: z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini']), aliases: z.string().refine(value => { const aliases = splitValues(value); return aliases.length <= 50 && aliases.every(alias => alias.length <= 200); }, '最多 50 个别名，每个不超过 200 个字符'),
  officialInputPrice: numberText('官方输入价格', 0, Number.MAX_SAFE_INTEGER, false, true), officialOutputPrice: numberText('官方输出价格', 0, Number.MAX_SAFE_INTEGER, false, true),
  contextWindow: numberText('上下文窗口', 1, Number.MAX_SAFE_INTEGER, true, true), expectedTps: numberText('预期输出速度', 1, Number.MAX_SAFE_INTEGER, true, true), knowledgeCutoff: z.string().max(10, '知识截止月份最多 10 个字符'), releasedAt: z.string().max(10),
  sortOrder: numberText('排序权重', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true, true), description: z.string().max(2000, '描述最多 2000 个字符'), isFeatured: z.boolean(), isActive: z.boolean(),
  title: z.string().max(200), contentMd: z.string().max(10000, '公告内容最多 10000 个字符'), enabled: z.boolean(), pinned: z.boolean(),
}).superRefine((values, ctx) => {
  const required = (key: 'slug' | 'name' | 'displayName' | 'vendorSlug' | 'title' | 'contentMd', label: string) => { if (!values[key].trim()) ctx.addIssue({ code: 'custom', path: [key], message: `请填写${label}` }); };
  if (values.kind === 'models') { required('slug', '标准模型标识'); required('displayName', '显示名称'); required('vendorSlug', '所属厂商'); if (values.slug && !/^[a-z0-9.-]+$/.test(values.slug)) ctx.addIssue({ code: 'custom', path: ['slug'], message: '标识仅支持小写字母、数字、点和短横线' }); }
  if (values.kind === 'vendors') { required('slug', '厂商标识'); required('name', '厂商名称'); if (values.slug && !/^[a-z0-9-]+$/.test(values.slug)) ctx.addIssue({ code: 'custom', path: ['slug'], message: '标识仅支持小写字母、数字和短横线' }); if (values.slug.length > 50) ctx.addIssue({ code: 'custom', path: ['slug'], message: '厂商标识最多 50 个字符' }); }
  if (values.kind === 'announcements') { required('title', '公告标题'); required('contentMd', '公告内容'); }
});
type CatalogFields = z.infer<typeof catalogSchema>;
function CatalogEditor({ kind, item, vendors, onSaved, onCancel }: { kind: Kind; item: Editable | null; vendors: AdminVendor[]; onSaved: () => void; onCancel: () => void }) {
  const model = item && 'displayName' in item ? item : null;
  const vendor = item && 'modelCount' in item ? item : null;
  const announcement = item && 'contentMd' in item ? item : null;
  const form = useForm<CatalogFields>({ resolver: zodResolver(catalogSchema), defaultValues: {
    kind, slug: model?.slug ?? vendor?.slug ?? '', name: vendor?.name ?? '', nameZh: vendor?.nameZh ?? '', color: vendor?.color ?? themes.light.primary, iconUrl: vendor?.iconUrl ?? '', website: vendor?.website ?? '',
    displayName: model?.displayName ?? '', vendorSlug: model?.vendor.slug ?? vendors[0]?.slug ?? '', family: model?.family ?? '', modality: model?.modality ?? 'text', tier: model?.tier ?? 'standard', defaultProtocol: model?.defaultProtocol ?? 'openai_chat', aliases: model?.aliases.join(', ') ?? '',
    officialInputPrice: model?.officialInputPrice == null ? '' : String(model.officialInputPrice), officialOutputPrice: model?.officialOutputPrice == null ? '' : String(model.officialOutputPrice), contextWindow: model?.contextWindow == null ? '' : String(model.contextWindow), expectedTps: model?.expectedTps == null ? '' : String(model.expectedTps), knowledgeCutoff: model?.knowledgeCutoff ?? '', releasedAt: model?.releasedAt?.slice(0, 10) ?? '',
    sortOrder: String(model?.sortOrder ?? vendor?.sortOrder ?? 0), description: model?.description ?? vendor?.description ?? '', isFeatured: model?.isFeatured ?? false, isActive: model?.isActive ?? true,
    title: announcement?.title ?? '', contentMd: announcement?.contentMd ?? '', enabled: announcement?.enabled ?? true, pinned: announcement?.pinned ?? false,
  } });
  const noun = kind === 'models' ? '模型' : kind === 'vendors' ? '厂商' : '公告';
  async function save(values: CatalogFields) {
    let body: VendorInput | ModelInput | Pick<Announcement, 'title' | 'contentMd' | 'enabled' | 'pinned'>;
    if (kind === 'models') body = { slug: values.slug.trim(), displayName: values.displayName.trim(), vendorSlug: values.vendorSlug, family: values.family.trim() || null, modality: values.modality, tier: values.tier, defaultProtocol: values.defaultProtocol, aliases: splitValues(values.aliases), officialInputPrice: optionalNumber(values.officialInputPrice), officialOutputPrice: optionalNumber(values.officialOutputPrice), contextWindow: optionalNumber(values.contextWindow), expectedTps: optionalNumber(values.expectedTps), knowledgeCutoff: values.knowledgeCutoff.trim() || null, releasedAt: values.releasedAt || null, description: values.description.trim() || null, sortOrder: Number(values.sortOrder || 0), isFeatured: values.isFeatured, isActive: values.isActive };
    else if (kind === 'vendors') body = { slug: values.slug.trim(), name: values.name.trim(), nameZh: values.nameZh.trim() || null, color: values.color, iconUrl: values.iconUrl.trim() || null,
      ...(values.website || !vendor || 'website' in vendor ? { website: values.website.trim() || null } : {}), ...(values.description || !vendor || 'description' in vendor ? { description: values.description.trim() || null } : {}), ...(values.sortOrder || !vendor ? { sortOrder: Number(values.sortOrder || 0) } : {}),
    };
    else body = { title: values.title.trim(), contentMd: values.contentMd, enabled: values.enabled, pinned: values.pinned };
    try { const { headers } = await apiWithHeaders<unknown>(`/admin/${kind}${item ? `/${item.id}` : ''}`, { method: item ? 'PATCH' : 'POST', body: JSON.stringify(body) }); toast.success(apiNoticeMessage(headers) ?? `${noun}已保存`); onSaved(); }
    catch (error) { toast.error(error instanceof Error ? error.message : '保存失败，请稍后重试'); }
  }
  return <Form {...form}><form onSubmit={form.handleSubmit(save)} className="space-y-5"><div className="grid gap-4 sm:grid-cols-2">
    {kind === 'models' && <>
      <AdminInput control={form.control} name="displayName" label="显示名称" /><AdminInput control={form.control} name="slug" label="标准模型标识" readOnly={Boolean(model)} description={model ? '创建后不可修改。' : '使用标准模型名称作为标识。'} />
      <AdminSelect control={form.control} name="vendorSlug" label="所属厂商" disabled={Boolean(model)} options={vendors.map(value => ({ value: value.slug, label: value.nameZh ?? value.name }))} /><AdminInput control={form.control} name="family" label="模型系列" />
      <AdminSelect control={form.control} name="modality" label="模态" options={Object.entries(modalityLabels).map(([value, label]) => ({ value, label }))} /><AdminSelect control={form.control} name="tier" label="级别" options={Object.entries(tierLabels).map(([value, label]) => ({ value, label }))} />
      <AdminSelect control={form.control} name="defaultProtocol" label="默认协议" options={Object.entries(PROTOCOL_LABELS).map(([value, label]) => ({ value, label }))} /><AdminInput control={form.control} name="aliases" label="上游别名" description="使用逗号分隔多个别名。" />
      <AdminInput control={form.control} name="officialInputPrice" label="官方输入价（美元/百万 Token）" type="number" min={0} step="any" /><AdminInput control={form.control} name="officialOutputPrice" label="官方输出价（美元/百万 Token）" type="number" min={0} step="any" />
      <AdminInput control={form.control} name="contextWindow" label="上下文窗口（Token）" type="number" min={1} step={1} /><AdminInput control={form.control} name="expectedTps" label="预期输出速度（Token/秒）" type="number" min={1} step={1} />
      <AdminInput control={form.control} name="knowledgeCutoff" label="知识截止月份" placeholder="例如 2026-10" /><AdminInput control={form.control} name="releasedAt" label="发布日期" type="date" />
      <AdminInput control={form.control} name="sortOrder" label="排序权重" type="number" step={1} /><AdminSwitch control={form.control} name="isActive" label="启用模型" /><AdminSwitch control={form.control} name="isFeatured" label="首页精选" />
    </>}
    {kind === 'vendors' && <>
      <AdminInput control={form.control} name="name" label="厂商名称" /><AdminInput control={form.control} name="slug" label="厂商标识" readOnly={Boolean(vendor)} description={vendor ? '创建后不可修改。' : undefined} />
      <AdminInput control={form.control} name="nameZh" label="中文名称" /><AdminInput control={form.control} name="color" label="品牌颜色" type="color" /><AdminInput control={form.control} name="iconUrl" label="品牌图标网址" type="url" /><AdminInput control={form.control} name="website" label="官方网站" type="url" /><AdminInput control={form.control} name="sortOrder" label="排序权重" type="number" step={1} />
    </>}
    {kind === 'announcements' && <><AdminInput control={form.control} name="title" label="公告标题" /><AdminSwitch control={form.control} name="enabled" label="发布公告" /><AdminSwitch control={form.control} name="pinned" label="置顶展示" /></>}
  </div>{kind === 'announcements' ? <AdminTextarea control={form.control} name="contentMd" label="公告内容" description="支持 Markdown 格式。" rows={10} /> : <AdminTextarea control={form.control} name="description" label="描述" />}
  <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onCancel}>取消</Button><Button disabled={form.formState.isSubmitting}>{form.formState.isSubmitting && <SpinnerGapIcon className="animate-spin" />}保存{noun}</Button></div></form></Form>;
}

export function CatalogManager({ kind, models = [], vendors, announcements = [], values }: { kind: Kind; models?: AdminModel[]; vendors: AdminVendor[]; announcements?: Announcement[]; values: SearchValues }) {
  const [editing, setEditing] = useState<Editable | null | undefined>(); const router = useRouter();
  const noun = kind === 'models' ? '模型' : kind === 'vendors' ? '厂商' : '公告'; const base = `/admin/${kind}`;
  const { page, pageSize } = paginationValues(values); const q = typeof values.q === 'string' ? values.q.trim().toLocaleLowerCase() : '';
  const filteredVendors = vendors.filter(item => `${item.name} ${item.nameZh ?? ''} ${item.slug}`.toLocaleLowerCase().includes(q));
  const filteredAnnouncements = announcements.filter(item => `${item.title} ${item.contentMd}`.toLocaleLowerCase().includes(q) && (!values.status || String(item.enabled) === values.status));
  const visibleVendors = kind === 'vendors' ? slicePage(filteredVendors, page, pageSize) : vendors;
  const visibleAnnouncements = slicePage(filteredAnnouncements, page, pageSize);
  return <div className="space-y-5"><div className="flex items-center justify-between gap-4"><p className="text-sm text-muted-foreground">{kind === 'models' ? '维护价格与检测基准，帮助用户准确比价。' : kind === 'vendors' ? '保持提供方资料和展示顺序准确。' : '让用户及时了解平台动态。'}</p><Button onClick={() => setEditing(null)}><PlusIcon />新增{noun}</Button></div>
    {kind !== 'models' && <AdminFilters key={searchString(values)} base={base} values={values} filters={[{ key: 'q', label: '关键词' }, ...(kind === 'announcements' ? [{ key: 'status', label: '发布状态', options: [{ value: 'true', label: '已发布' }, { value: 'false', label: '未发布' }] }] : [])]} />}
    <Dialog open={editing !== undefined} onOpenChange={open => { if (!open) setEditing(undefined); }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{editing ? '编辑' : '新增'}{noun}</DialogTitle><DialogDescription>核对以下资料后保存，修改将立即生效。</DialogDescription></DialogHeader>{editing !== undefined && <CatalogEditor key={editing?.id ?? 'new'} kind={kind} item={editing} vendors={vendors} onCancel={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); router.refresh(); }} />}</DialogContent></Dialog>
    {kind === 'models' && <AdminTable items={models} columns={[
      { label: '模型', render: item => <><div className="font-medium">{item.displayName}</div><div className="font-mono text-xs text-muted-foreground">{item.slug}</div></> },
      { label: '厂商 / 级别', render: item => <>{item.vendor.nameZh ?? item.vendor.name}<div className="text-xs text-muted-foreground">{tierLabels[item.tier]} · {modalityLabels[item.modality]}</div></> },
      { label: '输入 / 输出价（美元/百万 Token）', render: item => <span className="font-mono tabular-nums">{item.officialInputPrice ?? '—'} / {item.officialOutputPrice ?? '—'}</span> },
      { label: '状态', render: item => <Status value={item.isActive ? 'active' : 'paused'} /> },
      { label: '操作', render: item => <div className="flex flex-wrap gap-1.5"><Button size="sm" variant="outline" onClick={() => setEditing(item)}><PencilSimpleIcon />编辑</Button><MutationButton path={`/admin/models/${item.id}`} method="DELETE" confirmation={`确定删除模型「${item.displayName}」？此操作不可撤销。`}>删除</MutationButton></div> },
    ]} />}
    {kind === 'vendors' && <AdminTable items={visibleVendors} columns={[
      { label: '厂商', render: item => <><div className="font-medium">{item.name}</div><div className="text-xs text-muted-foreground">{item.nameZh ?? item.slug}</div></> },
      { label: '标准标识', render: item => <span className="font-mono">{item.slug}</span> }, { label: '模型 / 渠道', render: item => <span className="font-mono tabular-nums">{item.modelCount} / {item.channelCount}</span> },
      { label: '排序', render: item => <span className="font-mono tabular-nums">{item.sortOrder}</span> },
      { label: '操作', render: item => <div className="flex flex-wrap gap-1.5"><Button size="sm" variant="outline" onClick={() => setEditing(item)}><PencilSimpleIcon />编辑</Button><MutationButton path={`/admin/vendors/${item.id}`} method="DELETE" confirmation={`确定删除厂商「${item.name}」？仍被模型引用的厂商无法删除。`}>删除</MutationButton></div> },
    ]} />}
    {kind === 'announcements' && <AdminTable items={visibleAnnouncements} columns={[
      { label: '公告', render: item => <><div className="flex items-center gap-2 font-medium">{item.title}{item.pinned && <Badge variant="outline">置顶</Badge>}</div><p className="mt-1 max-w-lg whitespace-normal text-xs text-muted-foreground">{item.contentMd.slice(0, 150)}</p></> },
      { label: '状态', render: item => <Status value={item.enabled ? 'visible' : 'hidden'} /> }, { label: '发布时间', render: item => <DateValue value={item.createdAt} /> },
      { label: '操作', render: item => <div className="flex flex-wrap gap-1.5"><Button size="sm" variant="outline" onClick={() => setEditing(item)}><PencilSimpleIcon />编辑</Button><MutationButton path={`/admin/announcements/${item.id}`} body={{ enabled: !item.enabled }}>{item.enabled ? '停用' : '发布'}</MutationButton><MutationButton path={`/admin/announcements/${item.id}`} method="DELETE" confirmation={`确定删除公告「${item.title}」？此操作不可撤销。`}>删除</MutationButton></div> },
    ]} />}
    {kind !== 'models' && <DataPagination page={page} pageSize={pageSize} total={kind === 'vendors' ? filteredVendors.length : filteredAnnouncements.length} base={base} values={values} />}
  </div>;
}
