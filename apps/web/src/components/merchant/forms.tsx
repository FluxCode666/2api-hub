'use client';

import type { Control, FieldPath, FieldValues } from 'react-hook-form';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { PROTOCOL_LABELS, SITE_TYPE_LABELS, PAYMENT_METHOD_LABELS } from '@hub/shared';
import type { ChannelInput, MerchantChannel, MerchantSite, ModelSummary, SiteInput, VendorSummary } from '@hub/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function errorMessage(error: unknown) { return error instanceof Error ? error.message : '操作失败，请稍后重试。'; }
const optionalUrl = z.string().trim().refine((value) => !value || URL.canParse(value), '请输入有效的网址');
const positive = z.string().trim().refine((value) => value !== '' && Number.isFinite(Number(value)) && Number(value) > 0, '请输入大于 0 的数值');
const siteSchema = z.object({
  name: z.string().trim().min(1, '请填写站点名称').max(80, '最多 80 字'),
  type: z.enum(['new_api', 'sub2api', 'one_api', 'custom']),
  homepageUrl: z.string().trim().url('请输入有效的官网地址'),
  inviteUrl: optionalUrl, logoUrl: optionalUrl,
  slug: z.string().trim().regex(/^[a-z0-9-]*$/, '仅支持小写字母、数字和连字符'),
  rechargeRatio: positive,
  description: z.string().trim().max(2000, '最多 2000 字'), tags: z.string(),
  email: z.string().trim().refine((value) => !value || z.string().email().safeParse(value).success, '请输入有效邮箱'),
  qq: z.string().trim(), wechat: z.string().trim(), telegram: z.string().trim(), group: z.string().trim(),
  paymentMethods: z.array(z.string()),
});
type SiteValues = z.infer<typeof siteSchema>;
const channelSchema = z.object({
  name: z.string().trim().min(1, '请填写渠道名称').max(100, '最多 100 字'),
  description: z.string().trim(), vendorSlug: z.string(),
  protocol: z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini']),
  baseUrl: z.string().trim().url('请输入有效的接口地址'),
  apiKey: z.string().trim().max(500, 'API Key 最多 500 位').refine((value) => !value || value.length >= 8, 'API Key 长度至少 8 位'),
  groupRatio: positive,
  primaryModel: z.string().trim().min(1, '请填写主测模型'), backupModel: z.string().trim(),
  billingType: z.enum(['per_token', 'per_request', 'subscription']),
  rpmLimit: z.string().trim().refine((value) => !value || (Number.isInteger(Number(value)) && Number(value) >= 1), '请输入正整数'),
  declaredModels: z.string(),
});
type ChannelValues = z.infer<typeof channelSchema>;
const splitList = (value: string) => value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);

export function FormText<T extends FieldValues>({ control, name, label, hint, textarea, mono, ...props }: {
  control: Control<T>; name: FieldPath<T>; label: string; hint?: string; textarea?: boolean; mono?: boolean;
  type?: string; placeholder?: string; min?: string; step?: string; maxLength?: number; rows?: number; list?: string; autoComplete?: string;
}) {
  return <FormField control={control} name={name} render={({ field, formState }) => <FormItem>
    <FormLabel>{label}</FormLabel><FormControl>{textarea
      ? <Textarea {...field} value={String(field.value ?? '')} placeholder={props.placeholder} rows={props.rows} maxLength={props.maxLength} disabled={formState.isSubmitting} className={mono ? 'font-mono tabular-nums' : undefined} />
      : <Input {...field} {...props} value={String(field.value ?? '')} disabled={formState.isSubmitting} className={mono ? 'font-mono tabular-nums' : undefined} />}</FormControl>
    {hint && <FormDescription>{hint}</FormDescription>}<FormMessage />
  </FormItem>} />;
}

export function FormSelect<T extends FieldValues>({ control, name, label, options, emptyLabel }: {
  control: Control<T>; name: FieldPath<T>; label: string; options: { value: string; label: string }[]; emptyLabel?: string;
}) {
  return <FormField control={control} name={name} render={({ field, formState }) => <FormItem><FormLabel>{label}</FormLabel>
    <Select value={String(field.value) || '__none__'} onValueChange={(value) => field.onChange(value === '__none__' ? '' : value)} disabled={formState.isSubmitting}>
      <FormControl><SelectTrigger className="w-full"><SelectValue /></SelectTrigger></FormControl>
      <SelectContent>{emptyLabel && <SelectItem value="__none__">{emptyLabel}</SelectItem>}{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
    </Select><FormMessage />
  </FormItem>} />;
}

export function SiteForm({ site, onSave, submitLabel = '保存站点' }: { site?: MerchantSite; onSave: (input: SiteInput) => Promise<void>; submitLabel?: string }) {
  const form = useForm<SiteValues>({ resolver: zodResolver(siteSchema), defaultValues: {
    name: site?.name ?? '', type: site?.type ?? 'new_api', homepageUrl: site?.homepageUrl ?? '', inviteUrl: site?.inviteUrl ?? '', logoUrl: site?.logoUrl ?? '', slug: '',
    rechargeRatio: String(site?.rechargeRatio ?? 1), description: site?.description ?? '', tags: site?.tags.join(', ') ?? '',
    email: site?.contact.email ?? '', qq: site?.contact.qq ?? '', wechat: site?.contact.wechat ?? '', telegram: site?.contact.telegram ?? '', group: site?.contact.group ?? '', paymentMethods: site?.paymentMethods ?? [],
  } });
  async function submit(values: SiteValues) {
    const contact = Object.fromEntries(['email', 'qq', 'wechat', 'telegram', 'group'].flatMap((key) => { const value = values[key as keyof SiteValues]; return typeof value === 'string' && value ? [[key, value]] : []; }));
    const input: SiteInput = { name: values.name, homepageUrl: values.homepageUrl, inviteUrl: values.inviteUrl || null, logoUrl: values.logoUrl || null, description: values.description || null, type: values.type, rechargeRatio: Number(values.rechargeRatio), contact, tags: splitList(values.tags), paymentMethods: values.paymentMethods, ...(!site && values.slug ? { slug: values.slug } : {}) };
    try { await onSave(input); } catch (error) { toast.error(errorMessage(error)); }
  }
  return <Form {...form}><form className="space-y-6" onSubmit={form.handleSubmit(submit)} noValidate>
    <div className="grid gap-5 md:grid-cols-2">
      <FormText control={form.control} name="name" label="站点名称" placeholder="你的中转站名称" maxLength={80} />
      <FormSelect control={form.control} name="type" label="站点类型" options={Object.entries(SITE_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
      <FormText control={form.control} name="homepageUrl" label="官网地址" type="url" placeholder="https://example.com" />
      <FormText control={form.control} name="inviteUrl" label="邀请链接（可选）" type="url" placeholder="https://example.com/register?aff=..." />
      {!site && <FormText control={form.control} name="slug" label="站点标识（可选）" hint="用于公开档案网址，留空将自动生成。" placeholder="my-api" />}
      <FormText control={form.control} name="rechargeRatio" label="充值倍率" type="number" min="0.000001" step="any" mono hint="每充值 ¥1 获得的美元额度，例如 ¥1 = $1 时填 1。" />
      <FormText control={form.control} name="logoUrl" label="Logo 地址（可选）" type="url" placeholder="https://example.com/logo.png" />
      <FormText control={form.control} name="tags" label="标签" hint="使用逗号分隔。" placeholder="企业服务, 支持开票" />
    </div>
    <FormText control={form.control} name="description" label="站点简介" textarea rows={3} maxLength={2000} placeholder="说明渠道来源、服务特点和适用人群" />
    <fieldset className="space-y-4 rounded-lg border p-5"><legend className="px-2 text-sm font-medium">联系方式</legend><div className="grid gap-5 md:grid-cols-2">
      <FormText control={form.control} name="email" label="联系邮箱" type="email" placeholder="support@example.com" /><FormText control={form.control} name="telegram" label="Telegram" placeholder="@username" />
      <FormText control={form.control} name="qq" label="QQ" /><FormText control={form.control} name="wechat" label="微信" /><FormText control={form.control} name="group" label="交流群" />
    </div></fieldset>
    <FormField control={form.control} name="paymentMethods" render={({ field }) => <FormItem><FormLabel>支付方式</FormLabel><div className="flex flex-wrap gap-x-6 gap-y-3">{Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => <FormItem key={value} className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value.includes(value)} disabled={form.formState.isSubmitting} onCheckedChange={(checked) => field.onChange(checked === true ? [...field.value, value] : field.value.filter((item) => item !== value))} /></FormControl><FormLabel className="font-normal">{label}</FormLabel></FormItem>)}</div><FormMessage /></FormItem>} />
    <Button type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? '正在保存…' : submitLabel}</Button>
  </form></Form>;
}

export function ChannelForm({ channel, vendors, models, onSave, submitLabel = '保存渠道' }: { channel?: MerchantChannel; vendors: VendorSummary[]; models: ModelSummary[]; onSave: (input: ChannelInput) => Promise<void>; submitLabel?: string }) {
  const schema = channelSchema.superRefine((values, context) => { if (!channel && !values.apiKey) context.addIssue({ code: 'custom', path: ['apiKey'], message: 'API Key 长度至少 8 位' }); });
  const form = useForm<ChannelValues>({ resolver: zodResolver(schema), defaultValues: {
    name: channel?.name ?? '', description: channel?.description ?? '', vendorSlug: channel?.vendor?.slug ?? '', protocol: channel?.protocol ?? 'openai_chat', baseUrl: channel?.baseUrl ?? '', apiKey: '',
    groupRatio: String(channel?.groupRatio ?? 1), primaryModel: channel?.primaryModel ?? '', backupModel: channel?.backupModel ?? '', billingType: channel?.billingType ?? 'per_token', rpmLimit: channel?.rpmLimit == null ? '' : String(channel.rpmLimit), declaredModels: '',
  } });
  async function submit(values: ChannelValues) {
    const input: ChannelInput = { name: values.name, description: values.description || null, vendorSlug: values.vendorSlug || null, protocol: values.protocol, baseUrl: values.baseUrl, groupRatio: Number(values.groupRatio), primaryModel: values.primaryModel, backupModel: values.backupModel || null, billingType: values.billingType, rpmLimit: values.rpmLimit ? Number(values.rpmLimit) : null, ...(values.apiKey ? { apiKey: values.apiKey } : {}), ...(!channel ? { declaredModels: splitList(values.declaredModels) } : {}) };
    try { await onSave(input); form.setValue('apiKey', ''); if (!channel) form.reset(); } catch (error) { toast.error(errorMessage(error)); }
  }
  return <Form {...form}><form className="space-y-6" onSubmit={form.handleSubmit(submit)} noValidate>
    <div className="grid gap-5 md:grid-cols-2">
      <FormText control={form.control} name="name" label="渠道 / 分组名称" placeholder="例如 Claude 官方渠道" />
      <FormSelect control={form.control} name="vendorSlug" label="主要厂商" emptyLabel="多厂商 / 未指定" options={vendors.map((vendor) => ({ value: vendor.slug, label: vendor.nameZh ?? vendor.name }))} />
      <FormSelect control={form.control} name="protocol" label="API 协议" options={Object.entries(PROTOCOL_LABELS).map(([value, label]) => ({ value, label }))} />
      <FormText control={form.control} name="baseUrl" label="接口地址" type="url" mono placeholder="https://api.example.com" />
      <FormText control={form.control} name="apiKey" label={channel ? '更新检测密钥（可选）' : '检测用 API Key'} type="password" mono autoComplete="new-password" maxLength={500} placeholder={channel ? '留空不修改' : 'sk-...'} hint={channel ? `当前 ${channel.apiKeyMask}；留空保留原密钥。` : '至少 8 位。请使用独立、限额的检测密钥。'} />
      <FormText control={form.control} name="groupRatio" label="分组倍率" type="number" min="0.000001" step="any" mono hint="实际倍率 = 分组倍率 ÷ 站点充值倍率。" />
      <FormText control={form.control} name="primaryModel" label="主测模型" list="merchant-models" mono placeholder="上游模型 ID" />
      <FormText control={form.control} name="backupModel" label="备用模型（可选）" list="merchant-models" mono />
      <FormSelect control={form.control} name="billingType" label="计费方式" options={[{ value: 'per_token', label: '按 Token' }, { value: 'per_request', label: '按次' }, { value: 'subscription', label: '订阅' }]} />
      <FormText control={form.control} name="rpmLimit" label="每分钟请求上限（可选）" type="number" min="1" step="1" mono />
    </div>
    <datalist id="merchant-models">{models.map((model) => <option key={model.slug} value={model.slug}>{model.displayName}</option>)}</datalist>
    {!channel ? <FormText control={form.control} name="declaredModels" label="声明模型列表" hint="每行一个上游模型名，也可用逗号分隔；之后可从接口获取。" textarea mono rows={4} /> : <p className="text-sm text-muted-foreground">模型列表、目录映射与覆盖价请在下方「模型映射与价格」中维护。接口地址、API Key、协议或主测模型变化后会自动重新检测；倍率修改只更新价格。</p>}
    <FormText control={form.control} name="description" label="渠道说明" textarea rows={2} />
    <Button type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? '正在保存…' : submitLabel}</Button>
  </form></Form>;
}
