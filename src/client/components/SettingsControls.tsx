import { Children, cloneElement, useId, type ReactElement, type ReactNode } from "react";

// Negative margins extend the hover band without changing the spacing between rows.
// A disabled auxiliary button must not suppress hover while the row's form control is enabled.
const rowClassName = "-mx-3 -my-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 rounded-lg px-3 py-2 transition-colors hover:bg-background-container-high has-[input:disabled,select:disabled]:hover:bg-transparent";
const labelClassName = "block text-sm font-medium text-on-surface";
const hintClassName = "mt-0.5 block max-w-[65ch] text-xs leading-relaxed text-on-surface-variant";

function SettingsRowFrame({ label, hint, controlId, hintId, wide, children }: {
  label: string;
  hint?: string;
  controlId?: string;
  hintId?: string;
  wide: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`${rowClassName} ${wide ? "max-[820px]:grid-cols-1" : "max-[480px]:grid-cols-1"}`}>
      <div className="min-w-0">
        {controlId ? <label className={labelClassName} htmlFor={controlId}>{label}</label> : <span className={labelClassName}>{label}</span>}
        {hint && <p id={hintId} className={hintClassName}>{hint}</p>}
      </div>
      <div className={`min-w-0 ${wide ? "w-80 max-w-full max-[820px]:w-full" : ""}`}>{children}</div>
    </div>
  );
}

// Wrapped controls supply htmlFor and attach the hint description to their own input.
export function SettingsField({ label, hint, wide = true, htmlFor, children }: { label: string; hint?: string; wide?: boolean; htmlFor?: string; children: ReactNode }) {
  const generatedId = useId();
  const child = Children.only(children) as ReactElement<{ id?: string; "aria-describedby"?: string }>;
  const controlId = htmlFor ?? child.props.id ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const describedBy = [child.props["aria-describedby"], hintId].filter(Boolean).join(" ") || undefined;
  const control = htmlFor ? child : cloneElement(child, { id: controlId, "aria-describedby": describedBy });
  return <SettingsRowFrame label={label} hint={hint} controlId={controlId} hintId={hintId} wide={wide}>{control}</SettingsRowFrame>;
}

export function SettingsGroup({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const hintId = useId();
  return (
    <SettingsRowFrame label={label} hint={hint} hintId={hintId} wide>
      <div role="group" aria-label={label} aria-describedby={hint ? hintId : undefined}>{children}</div>
    </SettingsRowFrame>
  );
}

export function SettingsNumber({ label, hint, unit, value, onChange, min = 0, step = 1 }: {
  label: string;
  hint?: string;
  unit?: string;
  value: number | string;
  onChange: (value: string) => void;
  min?: number;
  step?: number;
}) {
  const inputId = useId();
  const hintId = hint ? `${inputId}-hint` : undefined;
  const unitId = unit ? `${inputId}-unit` : undefined;
  const describedBy = [hintId, unitId].filter(Boolean).join(" ") || undefined;
  return (
    <SettingsRowFrame label={label} hint={hint} controlId={inputId} hintId={hintId} wide={false}>
      <div className="flex w-44 max-w-full items-center overflow-hidden rounded-lg border border-outline-variant/30 bg-background focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary">
        <input id={inputId} aria-describedby={describedBy} className="w-full min-w-0 border-0 bg-transparent px-3 py-2 text-on-surface focus:outline-none" type="number" min={min} step={step} value={String(value)} onChange={(event) => onChange(event.target.value)} />
        {unit && <span id={unitId} className="shrink-0 pr-3 text-sm text-on-surface-variant">{unit}</span>}
      </div>
    </SettingsRowFrame>
  );
}

export function SettingsToggle({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
  restartRequired = false
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  restartRequired?: boolean;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const restartId = restartRequired ? `${id}-restart` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <label className={`${rowClassName} cursor-pointer has-[:disabled]:cursor-not-allowed`}>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span id={labelId} className={labelClassName}>{label}</span>
          {restartRequired && <span id={restartId} className="text-xs font-medium px-1.5 py-0.5 rounded bg-warning/15 text-warning">Restart Required</span>}
        </span>
        {hint && <span id={hintId} className={hintClassName}>{hint}</span>}
      </span>
      <span className="relative flex">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={[hintId, restartId].filter(Boolean).join(" ") || undefined}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span className={`relative mt-0.5 block w-10 h-6 shrink-0 rounded-full transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary peer-disabled:opacity-50 ${checked ? "bg-primary-dim" : "bg-outline-variant"}`}>
          <span className={`absolute top-1 w-4 h-4 rounded-full transition-all ${checked ? "bg-on-surface translate-x-5" : "bg-on-surface-variant translate-x-1"}`} />
        </span>
      </span>
    </label>
  );
}
