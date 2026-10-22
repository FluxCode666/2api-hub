'use client';
import {useForm} from 'react-hook-form';
import {zodResolver} from '@hookform/resolvers/zod';
import {z} from 'zod';
import {toast} from 'sonner';
import type {FeedbackInput} from '@hub/shared';
import {api} from '@/lib/api/client';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Card,CardContent} from '@/components/ui/card';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {Form,FormField,FormItem,FormLabel,FormControl,FormMessage} from '@/components/ui/form';
const schema=z.object({type:z.enum(['suggestion','recommend_site','complaint','bug']),content:z.string().trim().min(5,'详细说明至少 5 个字').max(4000,'详细说明最多 4000 个字'),contact:z.string().max(200).optional(),siteName:z.string().max(100).optional(),siteUrl:z.union([z.literal(''),z.url('请输入有效网址')]).optional()});
export function FeedbackForm(){
 const form=useForm<FeedbackInput>({resolver:zodResolver(schema),defaultValues:{type:'suggestion',content:'',contact:'',siteName:'',siteUrl:''}});
 async function submit(body:FeedbackInput){try{await api<{id:number}>('/feedback',{method:'POST',body:JSON.stringify(body)});toast.success('已收到你的反馈，感谢你让平台变得更好。');form.reset()}catch(error){toast.error(error instanceof Error?error.message:'提交失败，请稍后重试')}}
 return <Card className="feedback-form"><CardContent><Form {...form}><form className="space-y-5" onSubmit={form.handleSubmit(submit)}><div className="form-grid"><FormField control={form.control} name="type" render={({field})=><FormItem><FormLabel>反馈类型</FormLabel><Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger className="w-full"><SelectValue/></SelectTrigger></FormControl><SelectContent>{Object.entries({suggestion:'产品建议',recommend_site:'推荐收录站点',complaint:'投诉渠道',bug:'问题反馈'}).map(([key,label])=><SelectItem value={key} key={key}>{label}</SelectItem>)}</SelectContent></Select><FormMessage/></FormItem>}/>{(['contact','siteName','siteUrl'] as const).map((name,index)=><FormField key={name} control={form.control} name={name} render={({field})=><FormItem><FormLabel>{['联系方式（选填）','相关站点（选填）','站点地址（选填）'][index]}</FormLabel><FormControl><Input {...field} type={name==='siteUrl'?'url':'text'} placeholder={['邮箱或其他联系方式','站点名称','https://…'][index]}/></FormControl><FormMessage/></FormItem>}/>)}<FormField control={form.control} name="content" render={({field})=><FormItem className="full"><FormLabel>详细说明</FormLabel><FormControl><Textarea {...field} rows={5} placeholder="告诉我们你发现了什么，或希望改进什么。请不要填写 API Key、密码等敏感信息。"/></FormControl><FormMessage/></FormItem>}/></div><Button type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting?'正在提交…':'提交反馈 →'}</Button></form></Form></CardContent></Card>
}
