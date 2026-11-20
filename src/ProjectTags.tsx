import { useState } from 'react';
import type { Project } from './model';

export type ProjectTags = Pick<Project, 'subject' | 'academicYear'>;

export function matchesTag(value: string | undefined, filter: string) {
  return !filter || (value ? `tag:${value}` : 'unset') === filter;
}

export function TagFilter({
  label,
  options,
  value,
  onChange,
}: {
  label: '科目' | '年度';
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = value.startsWith('tag:') ? value.slice(4) : '';
  const choices = selected && !options.includes(selected) ? [...options, selected] : options;
  return (
    <label className="tag-filter">
      {label}
      <select
        aria-label={`${label}で絞り込む`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">すべて</option>
        {choices.map((tag) => (
          <option key={tag} value={`tag:${tag}`}>
            {label === '年度' ? `${tag}年度` : tag}
          </option>
        ))}
        <option value="unset">未設定</option>
      </select>
    </label>
  );
}

export function ProjectTagForm({
  project,
  subjects,
  years,
  onSave,
  onCancel,
}: {
  project: Project;
  subjects: string[];
  years: string[];
  onSave: (tags: ProjectTags) => Promise<void>;
  onCancel: () => void;
}) {
  const [subject, setSubject] = useState(project.subject || '');
  const [year, setYear] = useState(project.academicYear || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        const input = year.normalize('NFKC').trim();
        const academicYear = input.replace(/\s*年度$/, '');
        if (input && !/^\d{4}$/.test(academicYear)) {
          setError('年度は西暦4桁で入力してください。');
          return;
        }
        setSaving(true);
        setError('');
        try {
          await onSave({
            subject: subject.trim() || undefined,
            academicYear: academicYear || undefined,
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : 'タグを保存できませんでした。');
        } finally {
          setSaving(false);
        }
      }}
    >
      <p className="tag-project-name">{project.name}</p>
      <div className="tag-fields">
        <label className="field-label">
          科目名
          <input
            className="text-input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            list="lectern-subjects"
            maxLength={80}
            placeholder="例：物理学"
            autoFocus
          />
          <datalist id="lectern-subjects">
            {subjects.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </label>
        <label className="field-label">
          年度
          <input
            className="text-input"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            list="lectern-academic-years"
            inputMode="numeric"
            placeholder="例：2026"
            maxLength={12}
          />
          <datalist id="lectern-academic-years">
            {years.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </label>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={saving}>
          キャンセル
        </button>
        <button className="primary" disabled={saving}>
          保存する
        </button>
      </div>
    </form>
  );
}
