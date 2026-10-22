'use client';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { priceCny } from '@hub/shared';
import type { ChannelModelsInput, MerchantChannel, ModelSummary } from '@hub/shared';
import { searchString, type SearchValues } from '@/lib/query';
import { paginationValues } from '@/lib/pagination';
import { DataPagination } from '@/components/data-pagination';
import { Empty } from '@/components/page-kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from './forms';

const optionalPrice = z.string().trim().refine((value) => !value || (Number.isFinite(Number(value)) && Number(value) >= 0), '请输入非负价格');
const modelsSchema = z.object({ models: z.array(z.object({ upstreamName: z.string().trim().min(1, '请填写上游模型名').max(200), modelSlug: z.string(), priceOverrideInput: optionalPrice, priceOverrideOutput: optionalPrice })).max(200, '最多维护 200 个模型') }).superRefine((values, context) => {
  const used = new Set<string>();
  values.models.forEach((model, index) => { if (used.has(model.upstreamName)) context.addIssue({ code: 'custom', path: ['models', index, 'upstreamName'], message: '上游模型名不可重复' }); used.add(model.upstreamName); });
});
type ModelsValues = z.infer<typeof modelsSchema>;
const price = (value: string) => value.trim() ? Number(value) : null;

export function ModelsEditor({ channel, models, values, onSave }: { channel: MerchantChannel; models: ModelSummary[]; values: SearchValues; onSave: (input: ChannelModelsInput) => Promise<void> }) {
  const router = useRouter();
  const form = useForm<ModelsValues>({ resolver: zodResolver(modelsSchema), defaultValues: { models: channel.models.map((model) => ({ upstreamName: model.upstreamName, modelSlug: model.modelSlug ?? '', priceOverrideInput: model.priceOverrideInput == null ? '' : String(model.priceOverrideInput), priceOverrideOutput: model.priceOverrideOutput == null ? '' : String(model.priceOverrideOutput) })) } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'models' });
  const rows = useWatch({ control: form.control, name: 'models' });
  const pagination = paginationValues(values, 'modelsPage', 'modelsPageSize');
  const page = Math.min(pagination.page, Math.max(1, Math.ceil(fields.length / pagination.pageSize)));
  const start = (page - 1) * pagination.pageSize;
  const base = `/merchant/channels/${channel.id}`;
  async function submit(input: ModelsValues) {
    try { await onSave({ models: input.models.map((model) => ({ upstreamName: model.upstreamName, modelSlug: model.modelSlug || null, priceOverrideInput: price(model.priceOverrideInput), priceOverrideOutput: price(model.priceOverrideOutput) })) }); }
    catch (error) { toast.error(errorMessage(error)); }
  }
  function invalid() {
    const first = form.getValues('models').findIndex((_, index) => form.getFieldState(`models.${index}.upstreamName`).invalid || form.getFieldState(`models.${index}.priceOverrideInput`).invalid || form.getFieldState(`models.${index}.priceOverrideOutput`).invalid);
    if (first >= 0) router.replace(`${base}?${searchString(values, { modelsPage: String(Math.floor(first / pagination.pageSize) + 1) })}`, { scroll: false });
    toast.error('请检查模型名称与覆盖价，错误字段已标明。');
  }
  return <Form {...form}><form onSubmit={form.handleSubmit(submit, invalid)} className="space-y-5" noValidate>
    <p className="text-sm text-muted-foreground">将上游名称映射到标准模型。未指定映射时自动识别；覆盖价单位为 ¥/百万 Token，留空按官方价与实际倍率计算。</p>
    {fields.length ? <Table><TableHeader><TableRow><TableHead>上游模型名</TableHead><TableHead>标准模型映射</TableHead><TableHead>输入覆盖价 ¥/M</TableHead><TableHead>输出覆盖价 ¥/M</TableHead><TableHead>预计输入 / 输出 ¥/M</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>
      {fields.slice(start, start + pagination.pageSize).map((item, offset) => {
        const index = start + offset;
        const row = rows[index] ?? item;
        const model = models.find((entry) => entry.slug === row.modelSlug);
        const input = price(row.priceOverrideInput) ?? priceCny(model?.officialInputPrice, channel.actualRatio);
        const output = price(row.priceOverrideOutput) ?? priceCny(model?.officialOutputPrice, channel.actualRatio);
        return <TableRow key={item.id}>
          <TableCell className="min-w-48 align-top"><FormField control={form.control} name={`models.${index}.upstreamName`} render={({ field }) => <FormItem><FormLabel className="sr-only">第 {index + 1} 个上游模型名</FormLabel><FormControl><Input {...field} className="font-mono text-xs" disabled={form.formState.isSubmitting} /></FormControl><FormMessage /></FormItem>} /></TableCell>
          <TableCell className="min-w-48 align-top"><FormField control={form.control} name={`models.${index}.modelSlug`} render={({ field }) => <FormItem><FormLabel className="sr-only">{row.upstreamName || '新模型'} 标准模型映射</FormLabel><Select value={field.value || '__none__'} onValueChange={(value) => field.onChange(value === '__none__' ? '' : value)} disabled={form.formState.isSubmitting}><FormControl><SelectTrigger className="w-full text-xs"><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="__none__">自动识别 / 未映射</SelectItem>{models.map((entry) => <SelectItem key={entry.slug} value={entry.slug}>{entry.displayName}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>} /></TableCell>
          {(['priceOverrideInput', 'priceOverrideOutput'] as const).map((key) => <TableCell key={key} className="min-w-36 align-top"><FormField control={form.control} name={`models.${index}.${key}`} render={({ field }) => <FormItem><FormLabel className="sr-only">{row.upstreamName || '新模型'} {key === 'priceOverrideInput' ? '输入' : '输出'}覆盖价</FormLabel><FormControl><Input {...field} type="number" min="0" step="any" placeholder="自动计算" disabled={form.formState.isSubmitting} className="font-mono text-xs tabular-nums" /></FormControl><FormMessage /></FormItem>} /></TableCell>)}
          <TableCell className="font-mono text-xs tabular-nums">{input ?? '—'} / {output ?? '—'}</TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" type="button" disabled={form.formState.isSubmitting} onClick={() => remove(index)} aria-label={`移除 ${row.upstreamName || '新模型'}`}>移除</Button></TableCell>
        </TableRow>;
      })}
    </TableBody></Table> : <Empty title="还没有模型" description="可手动添加模型，或从上游接口获取模型列表。" />}
    <DataPagination page={page} pageSize={pagination.pageSize} total={fields.length} base={base} values={values} pageKey="modelsPage" pageSizeKey="modelsPageSize" />
    <div className="flex flex-wrap gap-2"><Button variant="outline" type="button" disabled={form.formState.isSubmitting || fields.length >= 200} onClick={() => { append({ upstreamName: '', modelSlug: '', priceOverrideInput: '', priceOverrideOutput: '' }, { shouldFocus: false }); const lastPage = Math.ceil((fields.length + 1) / pagination.pageSize); if (lastPage !== page) router.replace(`${base}?${searchString(values, { modelsPage: String(lastPage) })}`, { scroll: false }); }}>添加模型</Button><Button type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? '正在保存…' : '保存模型与价格'}</Button></div>
  </form></Form>;
}
