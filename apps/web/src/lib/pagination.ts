import type {SearchValues} from './query';

export function paginationValues(values:SearchValues,pageKey='page',pageSizeKey='pageSize'){
 const requested=Number(values[pageKey]);
 const page=Number.isSafeInteger(requested)&&requested>0?requested:1;
 const size=Number(values[pageSizeKey]);
 return {page,pageSize:[20,50,100].includes(size)?size:20};
}
export function slicePage<T>(items:T[],page:number,pageSize:number){return items.slice((page-1)*pageSize,page*pageSize)}
