-- Fix security issues: Function search path and extension schema

-- 1. Fix match_documents function with explicit search path
DROP FUNCTION IF EXISTS public.match_documents(vector, integer, jsonb);

CREATE OR REPLACE FUNCTION public.match_documents(
    query_embedding vector, 
    match_count integer DEFAULT NULL::integer, 
    filter jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE(id bigint, content text, metadata jsonb, similarity double precision)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
begin
  return query
  select
    id,
    content,
    metadata,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where metadata @> filter
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$function$;

-- 2. Create extensions schema and move vector extension
CREATE SCHEMA IF NOT EXISTS extensions;

-- Drop vector extension from public schema
DROP EXTENSION IF EXISTS vector CASCADE;

-- Install vector extension in extensions schema
CREATE EXTENSION vector WITH SCHEMA extensions;

-- Grant usage on extensions schema to public
GRANT USAGE ON SCHEMA extensions TO public;

-- Grant execute on all functions in extensions schema to public
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO public;

-- Ensure future functions in extensions schema are accessible
ALTER DEFAULT PRIVILEGES IN SCHEMA extensions GRANT EXECUTE ON FUNCTIONS TO public;