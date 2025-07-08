-- Recreate match_documents function for LangChain compatibility

-- Drop existing function variants
DROP FUNCTION IF EXISTS public.match_documents(jsonb, integer, extensions.vector);
DROP FUNCTION IF EXISTS public.match_documents(extensions.vector, integer, jsonb);
DROP FUNCTION IF EXISTS public.match_documents();

-- Create LangChain-compatible match_documents function
CREATE OR REPLACE FUNCTION public.match_documents(
    query_embedding vector(1536),
    match_count int DEFAULT null,
    filter jsonb DEFAULT '{}'
)
RETURNS TABLE(
    id bigint,
    content text,
    metadata jsonb,
    similarity float
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
begin
  return query
  select
    documents.id,
    documents.content,
    documents.metadata,
    (1 - (documents.embedding <=> query_embedding))::float as similarity
  from documents
  where documents.metadata @> filter
    and documents.embedding IS NOT NULL
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$$;