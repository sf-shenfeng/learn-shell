// DocumentsPage — Reading 列表页 (item 1,
// 门牌). "新文档" opens an inline create panel with two tabs: 粘贴
// (textarea) and 上传 (.md/.txt drag-and-drop, brief §0's "格式：只收
// Markdown（.md/.txt 同管道）"). Existing documents list below, newest
// updated first — same "card list, no dashboard chrome" dialect
// pages/Courses.tsx already establishes for its own landing page.

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useDocumentRepo } from './useDocumentRepo';
import type { DocumentSource } from './types';
import { usePair } from '../shell/PairProvider';
import { useT } from '../i18n';

type CreateTab = 'paste' | 'upload';

const SOURCE_LABEL_KEY = {
  paste: 'document.source.paste',
  upload: 'document.source.upload',
  mcp: 'document.source.mcp',
} as const;

function relativeTime(iso: string, lang: 'zh' | 'en'): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return lang === 'zh' ? '刚刚' : 'just now';
  if (min < 60) return lang === 'zh' ? `${min} 分钟前` : `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return lang === 'zh' ? `${h} 小时前` : `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return lang === 'zh' ? `${d} 天前` : `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function DocumentsPage() {
  const repo = useDocumentRepo();
  const { pairId } = usePair();
  const { t, lang } = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const docsQ = useQuery({
    queryKey: ['documents', pairId],
    queryFn: () => (repo && pairId ? repo.getDocuments(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });

  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<CreateTab>('paste');
  const [titleDraft, setTitleDraft] = useState('');
  const [contentDraft, setContentDraft] = useState('');
  const [filename, setFilename] = useState<string | undefined>(undefined);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createMut = useMutation({
    mutationFn: (input: { title?: string; content_md: string; source: DocumentSource; filename?: string }) => {
      if (!repo || !pairId) throw new Error('no repo/pair');
      return repo.createDocument({ pair_id: pairId, ...input });
    },
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: ['documents', pairId] });
      qc.invalidateQueries({ queryKey: ['journal-documents', pairId] });
      qc.invalidateQueries({ queryKey: ['recent-rail', 'documents', pairId] });
      setPanelOpen(false);
      setTitleDraft('');
      setContentDraft('');
      setFilename(undefined);
      navigate(`/documents/${doc.id}`);
    },
  });

  function loadFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setContentDraft(String(reader.result ?? ''));
      setFilename(file.name);
    };
    reader.readAsText(file);
  }

  if (!repo) {
    return <p className="text-sm text-[var(--ls-text-secondary)]">{t('document.emptyMode')}</p>;
  }

  const documents = docsQ.data ?? [];

  return (
    <div>
      <div
        className="flex items-start justify-between flex-wrap"
        style={{ gap: '14px', marginBottom: '20px' }}
      >
        <div>
          <h1
            className="font-bold text-[24px] leading-[32px] tracking-[-0.02em]"
            style={{ margin: 0, marginBottom: '4px' }}
          >
            {t('document.pageTitle')}
          </h1>
          <p className="text-[13px] leading-5 text-[var(--ls-text-secondary)]" style={{ maxWidth: '560px' }}>
            {t('document.pageSubtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPanelOpen((v) => !v)}
          className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 transition-opacity duration-[var(--ls-duration-fast)]"
          style={{ height: '34px', padding: '0 16px', borderRadius: '6px', fontSize: '12px' }}
        >
          {panelOpen ? t('annotation.cancel') : t('document.newDocument')}
        </button>
      </div>

      {panelOpen && (
        <section
          className="border border-[var(--ls-border)]"
          style={{ borderRadius: '10px', padding: '16px 18px', marginBottom: '24px', maxWidth: '760px' }}
        >
          <div className="flex items-center" style={{ gap: '4px', marginBottom: '14px' }}>
            {(['paste', 'upload'] as CreateTab[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className="font-medium transition-colors duration-[var(--ls-duration-fast)]"
                style={{
                  height: '28px',
                  padding: '0 12px',
                  borderRadius: '999px',
                  fontSize: '12px',
                  border: tab === k ? 'none' : '1px solid var(--ls-border)',
                  background: tab === k ? 'var(--ls-text)' : 'transparent',
                  color: tab === k ? 'var(--ls-bg)' : 'var(--ls-text-secondary)',
                }}
              >
                {k === 'paste' ? t('document.pasteTab') : t('document.uploadTab')}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder={t('document.titlePlaceholder')}
            className="w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] placeholder:text-[var(--ls-text-tertiary)] focus:outline-none focus:border-[var(--ls-border-strong)]"
            style={{ height: '32px', padding: '0 10px', borderRadius: '6px', fontSize: '13px', marginBottom: '10px' }}
          />

          {tab === 'paste' ? (
            <textarea
              value={contentDraft}
              onChange={(e) => setContentDraft(e.target.value)}
              placeholder={t('document.contentPlaceholder')}
              rows={12}
              className="w-full font-mono text-[13px] leading-6 border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] placeholder:text-[var(--ls-text-tertiary)] focus:outline-none focus:border-[var(--ls-border-strong)] resize-y"
              style={{ padding: '12px 14px', borderRadius: '8px' }}
            />
          ) : (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const file = e.dataTransfer.files?.[0];
                if (file) loadFile(file);
              }}
              onClick={() => fileInputRef.current?.click()}
              className="flex flex-col items-center justify-center text-center cursor-pointer transition-colors duration-[var(--ls-duration-fast)]"
              style={{
                height: '160px',
                borderRadius: '8px',
                border: `1.5px dashed ${dragOver ? 'var(--ls-structure)' : 'var(--ls-border)'}`,
                background: dragOver ? 'var(--ls-panel)' : 'transparent',
                padding: '16px',
              }}
            >
              {filename ? (
                <>
                  <div className="text-[13px] font-medium">{filename}</div>
                  <div className="text-[11px] text-[var(--ls-text-tertiary)]" style={{ marginTop: '4px' }}>
                    {contentDraft.length} {t('document.charsSuffix')}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-[13px] text-[var(--ls-text-secondary)]">{t('document.dropHint')}</div>
                  <div className="text-[11px] text-[var(--ls-text-tertiary)]" style={{ marginTop: '4px' }}>
                    {t('document.dropFormatHint')}
                  </div>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.txt"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) loadFile(file);
                }}
              />
            </div>
          )}

          <div className="flex items-center" style={{ gap: '10px', marginTop: '12px' }}>
            <button
              type="button"
              onClick={() =>
                createMut.mutate({
                  title: titleDraft.trim() || undefined,
                  content_md: contentDraft,
                  source: tab,
                  filename,
                })
              }
              disabled={!contentDraft.trim() || createMut.isPending}
              className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium disabled:opacity-40"
              style={{ height: '32px', padding: '0 16px', borderRadius: '6px', fontSize: '12px' }}
            >
              {createMut.isPending ? t('document.saving') : t('document.create')}
            </button>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className="text-[12px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
            >
              {t('annotation.cancel')}
            </button>
          </div>
        </section>
      )}

      {documents.length === 0 ? (
        <div
          className="border border-dashed border-[var(--ls-border)] text-[13px] leading-5 text-[var(--ls-text-tertiary)]"
          style={{ padding: '20px', borderRadius: '8px', maxWidth: '760px' }}
        >
          {t('document.emptyState')}
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: '8px', maxWidth: '760px' }}>
          {documents.map((d) => (
            <Link
              key={d.id}
              to={`/documents/${d.id}`}
              className="flex items-center justify-between border border-[var(--ls-border)] hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
              style={{ padding: '13px 16px', borderRadius: '8px', gap: '14px' }}
            >
              <span className="truncate text-[14px]" style={{ minWidth: 0 }}>
                {d.title}
              </span>
              <span
                className="flex items-center flex-none text-[11px] text-[var(--ls-text-tertiary)]"
                style={{ gap: '10px' }}
              >
                <span
                  style={{
                    padding: '1px 7px',
                    border: '1px solid var(--ls-border)',
                    borderRadius: '999px',
                  }}
                >
                  {t(SOURCE_LABEL_KEY[d.source])}
                </span>
                <span>{relativeTime(d.updated_at, lang)}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
