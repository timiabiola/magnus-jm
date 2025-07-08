-- Fix match_documents function issues

-- 1. Add missing embedding column to documents table
ALTER TABLE public.documents 
ADD COLUMN IF NOT EXISTS embedding extensions.vector(1536);

-- 2. Drop and recreate the function with correct parameter order
DROP FUNCTION IF EXISTS public.match_documents(vector, integer, jsonb);
DROP FUNCTION IF EXISTS public.match_documents(jsonb, integer, vector);

-- 3. Create function with correct parameter order: filter, match_count, query_embedding
CREATE OR REPLACE FUNCTION public.match_documents(
    filter jsonb DEFAULT '{}'::jsonb,
    match_count integer DEFAULT NULL::integer,
    query_embedding extensions.vector DEFAULT NULL::extensions.vector
)
RETURNS TABLE(id bigint, content text, metadata jsonb, similarity double precision)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
begin
  -- Handle case where no query_embedding is provided
  if query_embedding IS NULL then
    return query
    select
      documents.id,
      documents.content,
      documents.metadata,
      0.0 as similarity
    from documents
    where documents.metadata @> filter
    order by documents.id
    limit match_count;
  end if;

  return query
  select
    documents.id,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where documents.metadata @> filter
    and documents.embedding IS NOT NULL
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$function$;