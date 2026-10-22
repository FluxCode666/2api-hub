'use client';

import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { FloppyDiskIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import type { SettingsMap } from '@hub/shared';
import { apiWithHeaders, apiNoticeMessage } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AdminInput, AdminSelect, AdminSwitch, numberText } from './form-fields';

const numericSettings = [
  ['defaultIntervalSec', 'probe.defaultIntervalSec', '默认探测间隔（秒）', 30, 86400], ['concurrency', 'probe.concurrency', '全局探测并发', 1, 100], ['perSiteConcurrency', 'probe.perSiteConcurrency', '单站点并发', 1, 20], ['timeoutMs', 'probe.timeoutMs', '探测超时（毫秒）', 1000, 120000],
  ['intervalHours', 'authenticity.intervalHours', '主测模型检测间隔（小时）', 1, 720], ['merchantDailyLimit', 'authenticity.merchantDailyLimit', '站长每日手动检测次数', 1, 100], ['hourlyLimitPerIp', 'verify.hourlyLimitPerIp', '公开鉴定每个 IP 每小时次数', 1, 1000],
] as const;
const weightFields = ['uptime', 'latency', 'trust', 'stability'] as const;
const settingsSchema = z.object({ defaultIntervalSec: numberText('默认探测间隔', 30, 86400, true), concurrency: numberText('全局探测并发', 1, 100, true), perSiteConcurrency: numberText('单站点并发', 1, 20, true), timeoutMs: numberText('探测超时', 1000, 120000, true), intervalHours: numberText('真伪检测间隔', 1, 720, true), modelScope: z.enum(['primary', 'featured', 'all']), secondaryIntervalHours: numberText('非主测模型检测间隔', 1, 720, true), merchantDailyLimit: numberText('每日检测次数', 1, 100, true), hourlyLimitPerIp: numberText('每小时鉴定次数', 1, 1000, true), uptime: numberText('可用率权重', 0, 1), latency: numberText('响应延迟权重', 0, 1), trust: numberText('可信分权重', 0, 1), stability: numberText('稳定性权重', 0, 1), allowRegistration: z.boolean(), announcementBar: z.string().max(500, '公告栏最多 500 个字符') }).superRefine((values, ctx) => { if (weightFields.reduce((sum, key) => sum + Number(values[key]), 0) <= 0) ctx.addIssue({ code: 'custom', path: ['uptime'], message: '评分权重总和必须大于 0' }); });
type SettingsFields = z.infer<typeof settingsSchema>;
export function SettingsEditor({ settings }: { settings: SettingsMap }) {
  const router = useRouter(); const weights = settings['scoring.weights'];
  const form = useForm<SettingsFields>({ resolver: zodResolver(settingsSchema), defaultValues: { defaultIntervalSec: String(settings['probe.defaultIntervalSec']), concurrency: String(settings['probe.concurrency']), perSiteConcurrency: String(settings['probe.perSiteConcurrency']), timeoutMs: String(settings['probe.timeoutMs']), intervalHours: String(settings['authenticity.intervalHours']), modelScope: settings['authenticity.modelScope'], secondaryIntervalHours: String(settings['authenticity.secondaryIntervalHours']), merchantDailyLimit: String(settings['authenticity.merchantDailyLimit']), hourlyLimitPerIp: String(settings['verify.hourlyLimitPerIp']), uptime: String(weights.uptime), latency: String(weights.latency), trust: String(weights.trust), stability: String(weights.stability), allowRegistration: settings['site.allowRegistration'], announcementBar: settings['site.announcementBar'] } });
  async function save(values: SettingsFields) {
    const body: SettingsMap = { ...settings, 'authenticity.modelScope': values.modelScope, 'authenticity.secondaryIntervalHours': Number(values.secondaryIntervalHours), 'scoring.weights': { uptime: Number(values.uptime), latency: Number(values.latency), trust: Number(values.trust), stability: Number(values.stability) }, 'site.allowRegistration': values.allowRegistration, 'site.announcementBar': values.announcementBar };
    for (const [name, key] of numericSettings) body[key] = Number(values[name]);
    try { const { headers } = await apiWithHeaders<unknown>('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }); toast.success(apiNoticeMessage(headers) ?? '系统设置已保存'); router.refresh(); }
    catch (error) { toast.error(error instanceof Error ? error.message : '保存失败，请稍后重试'); }
  }
  return <Form {...form}><form onSubmit={form.handleSubmit(save)} className="space-y-6"><Card><CardHeader><CardTitle>探测与访问限制</CardTitle><CardDescription>按服务容量调整频率与并发，修改后自动应用。</CardDescription></CardHeader><CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{numericSettings.map(([name, , label, min, max]) => <AdminInput key={name} control={form.control} name={name} label={label} type="number" min={min} max={max} step={1} />)}</CardContent></Card>
    <Card><CardHeader><CardTitle>定时模型检测</CardTitle><CardDescription>主测模型按主测检测间隔执行，其余已映射到目录的声明模型按下列范围与间隔执行。检测范围越大，对上游的请求越多，也可能增加 Token 费用；请结合预算设置。</CardDescription></CardHeader><CardContent className="grid gap-5 sm:grid-cols-2"><AdminSelect control={form.control} name="modelScope" label="定时检测范围" options={[{value:"primary",label:"仅主测模型"},{value:"featured",label:"主测 + 精选模型"},{value:"all",label:"全部声明模型"}]} /><AdminInput control={form.control} name="secondaryIntervalHours" label="非主测模型检测间隔（小时）" type="number" min={1} max={720} step={1} description="默认 48 小时；从未检测过的范围内模型将优先执行。" /></CardContent></Card>
    <Card><CardHeader><CardTitle>推荐分权重</CardTitle><CardDescription>权重按总和归一化。价格独立排序；不足 6 个样本时不计算推荐分。</CardDescription></CardHeader><CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{([['uptime', '可用率'], ['latency', '响应延迟'], ['trust', '模型可信分'], ['stability', '连续稳定性']] as const).map(([name, label]) => <AdminInput key={name} control={form.control} name={name} label={label} type="number" min={0} max={1} step={0.01} />)}</CardContent></Card>
    <Card><CardHeader><CardTitle>站点设置</CardTitle></CardHeader><CardContent className="space-y-5"><AdminSwitch control={form.control} name="allowRegistration" label="开放新用户注册" /><AdminInput control={form.control} name="announcementBar" label="全站公告栏" /></CardContent></Card>
    <Button disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? <SpinnerGapIcon className="animate-spin" /> : <FloppyDiskIcon />}保存系统设置</Button>
  </form></Form>;
}
