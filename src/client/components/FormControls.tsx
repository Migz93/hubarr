import type { ReactNode } from "react";

export function SectionCard({
  title,
  description,
  children,
  wide = false
}: {
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className={`bg-surface-container rounded-2xl border border-outline-variant/20 p-5 ${
        wide ? "w-full" : ""
      }`}
    >
      <div className="mb-4">
        <h3 className="font-headline font-semibold text-base text-on-surface">{title}</h3>
        {description && (
          <p className="text-on-surface-variant text-sm mt-1">{description}</p>
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-on-surface mb-1.5">{label}</label>
      {hint && <div className="text-xs text-on-surface-variant mb-1.5">{hint}</div>}
      {children}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text"
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="w-full bg-surface-container-low border border-outline-variant/30 rounded-lg px-3 py-2 text-on-surface text-sm placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50"
    />
  );
}

export function SelectInput({
  value,
  onChange,
  children
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full bg-surface-container-low border border-outline-variant/30 rounded-lg px-3 py-2 text-on-surface text-sm focus:outline-none focus:border-primary/50"
    >
      {children}
    </select>
  );
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange,
  restartRequired = false
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  restartRequired?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <div className="relative flex-shrink-0 mt-0.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="sr-only"
        />
        <div
          className={`w-10 h-6 rounded-full transition-colors ${
            checked ? "bg-primary" : "bg-outline-variant"
          }`}
        />
        <div
          className={`absolute top-1 w-4 h-4 rounded-full transition-all ${
            checked ? "bg-white translate-x-5" : "bg-on-surface-variant translate-x-1"
          }`}
        />
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-on-surface">{label}</span>
          {restartRequired && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-warning/15 text-warning">
              Restart Required
            </span>
          )}
        </div>
        {hint && <div className="text-xs text-on-surface-variant mt-0.5">{hint}</div>}
      </div>
    </label>
  );
}

export function SaveBar({
  saving,
  success,
  error,
  onSave,
  label = "Save"
}: {
  saving: boolean;
  success: boolean;
  error: string | null;
  onSave: () => void;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <button
        disabled={saving}
        onClick={onSave}
        className="bg-primary hover:bg-primary-dim disabled:opacity-50 text-on-primary text-sm font-semibold rounded-xl px-4 py-2 transition-colors"
      >
        {saving ? "Saving..." : label}
      </button>
      {success && <span className="text-success text-sm">Saved</span>}
      {error && <span className="text-error text-sm">{error}</span>}
    </div>
  );
}
