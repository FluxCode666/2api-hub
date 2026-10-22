'use client';
import {useRouter} from 'next/navigation';
import {useForm} from 'react-hook-form';
import {zodResolver} from '@hookform/resolvers/zod';
import {z} from 'zod';
import {toast} from 'sonner';
import type {ReviewInput} from '@hub/shared';
import {api} from '@/lib/api/client';
import {searchString,type SearchValues} from '@/lib/query';
import {Button} from './ui/button';
import {Textarea} from './ui/textarea';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from './ui/select';
import {Form,FormField,FormItem,FormLabel,FormControl,FormMessage,FormDescription} from './ui/form';
const reviewSchema=z.object({rating:z.number().int().min(1).max(5),content:z.string().trim().min(5,'请至少填写 5 个字。').max(2000,'评价最多 2000 个字。')});
export function ReviewForm({slug,values={}}:{slug:string;values?:SearchValues}){const router=useRouter();const form=useForm<ReviewInput>({resolver:zodResolver(reviewSchema),defaultValues:{rating:5,content:''}});async function save(body:ReviewInput){try{await api(`/sites/${encodeURIComponent(slug)}/reviews`,{method:'POST',body:JSON.stringify(body)});toast.success('评价已保存，感谢你的真实反馈。');form.reset();if(typeof values.reviewsPage==='string'&&Number(values.reviewsPage)>1){router.replace(`/sites/${encodeURIComponent(slug)}?${searchString(values,{reviewsPage:undefined})}#reviews`,{scroll:false})}else router.refresh()}catch(error){toast.error(error instanceof Error?error.message:'提交失败，请先登录。')}}return <Form {...form}><form className="mt-6 space-y-4 border-t pt-6" onSubmit={form.handleSubmit(save)}><h3 className="font-medium">分享你的使用体验</h3><FormField control={form.control} name="rating" render={({field})=><FormItem><FormLabel>评分</FormLabel><Select value={String(field.value)} onValueChange={value=>field.onChange(Number(value))}><FormControl><SelectTrigger className="w-full"><SelectValue/></SelectTrigger></FormControl><SelectContent>{[[5,'很满意'],[4,'满意'],[3,'一般'],[2,'不满意'],[1,'很差']].map(([score,label])=><SelectItem value={String(score)} key={score}>{score} 分 · {label}</SelectItem>)}</SelectContent></Select><FormMessage/></FormItem>}/><FormField control={form.control} name="content" render={({field})=><FormItem><FormLabel>评价内容</FormLabel><FormControl><Textarea {...field} rows={4} maxLength={2000} placeholder="哪些体验值得推荐，哪些地方还需要改进？"/></FormControl><FormDescription>登录后可评价，每个账号对同一站点保留一条评价，再次提交会更新。</FormDescription><FormMessage/></FormItem>}/><Button disabled={form.formState.isSubmitting} type="submit">{form.formState.isSubmitting?'正在保存…':'保存评价'}</Button></form></Form>}
