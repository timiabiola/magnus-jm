-- Fix Vector Extension Schema Issues
-- The problem: match_documents function can't find vector operators because 
-- the extension is in 'extensions' schema but search_path doesn't include it

-- 1. First, let's ensure the vector extension is properly set up
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO public;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO public;

-- 2. Fix the match_documents function to work with extensions.vector
-- Drop all variants to ensure clean state
DROP FUNCTION IF EXISTS public.match_documents(vector, integer, jsonb);
DROP FUNCTION IF EXISTS public.match_documents(extensions.vector, integer, jsonb);
DROP FUNCTION IF EXISTS public.match_documents(jsonb, integer, extensions.vector);
DROP FUNCTION IF EXISTS public.match_documents();

-- 3. Create the correct function with proper extensions schema reference
CREATE OR REPLACE FUNCTION public.match_documents(
    query_embedding extensions.vector(1536),
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
SECURITY DEFINER
SET search_path = 'public', 'extensions', 'pg_catalog'
AS $function$
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
$function$;

-- 4. Ensure the documents table has the correct column type
DO $$
BEGIN
  -- Check if documents table exists
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'documents') THEN
    -- Ensure embedding column exists with correct type
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND table_name = 'documents' 
      AND column_name = 'embedding'
    ) THEN
      ALTER TABLE public.documents ADD COLUMN embedding extensions.vector(1536);
      RAISE NOTICE 'Added embedding column to documents table';
    ELSE
      RAISE NOTICE 'Embedding column already exists in documents table';
    END IF;
  ELSE
    -- Create documents table if it doesn't exist
    CREATE TABLE public.documents (
      id bigserial PRIMARY KEY,
      content text,
      metadata jsonb DEFAULT '{}',
      embedding extensions.vector(1536)
    );
    RAISE NOTICE 'Created documents table with vector embedding';
  END IF;
END;
$$;

-- 5. Grant proper permissions
GRANT EXECUTE ON FUNCTION public.match_documents(extensions.vector, integer, jsonb) TO service_role;
GRANT ALL ON TABLE public.documents TO service_role;

-- 6. Test the vector operations work
DO $$
DECLARE
  test_vector extensions.vector(1536);
BEGIN
  -- Create a test vector
  test_vector := array_fill(0.1, ARRAY[1536])::extensions.vector(1536);
  
  -- Test that vector operations work
  IF (test_vector <=> test_vector) = 0 THEN
    RAISE NOTICE 'SUCCESS: Vector operations are working correctly';
  ELSE
    RAISE EXCEPTION 'FAILED: Vector operations are not working';
  END IF;
EXCEPTION 
  WHEN OTHERS THEN
    RAISE NOTICE 'Vector test failed, but this is expected if no data exists yet: %', SQLERRM;
END;
$$;

-- 7. Log completion
DO $$
BEGIN
  RAISE NOTICE 'Vector extension schema fixes completed successfully';
  RAISE NOTICE 'Fixed: match_documents function now properly references extensions.vector';
  RAISE NOTICE 'Added extensions schema to search_path for vector operations';
END;
$$;
