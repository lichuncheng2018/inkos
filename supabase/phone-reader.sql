-- InkOS phone reader. Run once in the Supabase SQL editor.
create table if not exists public.inkos_books (
  id text primary key,
  title text not null default '',
  genre text,
  language text,
  updated_at timestamptz not null default now()
);

create table if not exists public.inkos_chapters (
  book_id text not null references public.inkos_books(id) on delete cascade,
  chapter_no int not null check (chapter_no >= 1),
  title text not null default '',
  content text not null default '',
  word_count int,
  updated_at timestamptz not null default now(),
  primary key (book_id, chapter_no)
);

alter table public.inkos_books enable row level security;
alter table public.inkos_chapters enable row level security;

drop policy if exists inkos_books_public_read on public.inkos_books;
create policy inkos_books_public_read on public.inkos_books
  for select using (true);

drop policy if exists inkos_chapters_public_read on public.inkos_chapters;
create policy inkos_chapters_public_read on public.inkos_chapters
  for select using (true);

grant select on public.inkos_books to anon, authenticated;
grant select on public.inkos_chapters to anon, authenticated;

insert into storage.buckets (id, name, public)
values ('inkos-reader', 'inkos-reader', true)
on conflict (id) do update set public = true;

drop policy if exists inkos_reader_public_read on storage.objects;
create policy inkos_reader_public_read
on storage.objects for select
using (bucket_id = 'inkos-reader');
