'use client';
import * as React from 'react';
import {Slot} from 'radix-ui';
import {Controller,FormProvider,useFormContext,useFormState,type ControllerProps,type FieldPath,type FieldValues} from 'react-hook-form';
import {cn} from '@/lib/utils';
import {Label} from './label';

const Form=FormProvider;
const FieldContext=React.createContext<{name:string}>({name:''});
const ItemContext=React.createContext<{id:string}>({id:''});
function FormField<TValues extends FieldValues,TName extends FieldPath<TValues>>(props:ControllerProps<TValues,TName>){return <FieldContext.Provider value={{name:props.name}}><Controller {...props}/></FieldContext.Provider>}
function useFormField(){const{name}=React.useContext(FieldContext);const{id}=React.useContext(ItemContext);const{getFieldState}=useFormContext();const state=useFormState({name});return {name,id,formItemId:`${id}-item`,formDescriptionId:`${id}-description`,formMessageId:`${id}-message`,...getFieldState(name,state)}}
function FormItem({className,...props}:React.ComponentProps<'div'>){const id=React.useId();return <ItemContext.Provider value={{id}}><div data-slot="form-item" className={cn('grid gap-2',className)} {...props}/></ItemContext.Provider>}
function FormLabel(props:React.ComponentProps<typeof Label>){const{error,formItemId}=useFormField();return <Label data-error={!!error} htmlFor={formItemId} {...props}/>}
function FormControl(props:React.ComponentProps<typeof Slot.Root>){const{error,formItemId,formDescriptionId,formMessageId}=useFormField();return <Slot.Root id={formItemId} aria-describedby={error?`${formDescriptionId} ${formMessageId}`:formDescriptionId} aria-invalid={!!error} {...props}/>}
function FormDescription({className,...props}:React.ComponentProps<'p'>){const{formDescriptionId}=useFormField();return <p id={formDescriptionId} className={cn('text-xs text-muted-foreground',className)} {...props}/>}
function FormMessage({className,children,...props}:React.ComponentProps<'p'>){const{error,formMessageId}=useFormField();const body=error?String(error.message??''):children;return body?<p id={formMessageId} className={cn('text-xs text-danger',className)} role="alert" {...props}>{body}</p>:null}
export {Form,FormField,FormItem,FormLabel,FormControl,FormDescription,FormMessage,useFormField};
