import { Field, Input, Textarea } from "@/components/ui/form";
import { connectorDef } from "./connectors";
import type { ConfigDraft, ConnectorKind } from "./connectors";

export function ConfigFields({
  kind,
  draft,
  onChange,
  errors,
  idPrefix,
  disabled,
}: {
  kind: ConnectorKind;
  draft: ConfigDraft;
  onChange: (d: ConfigDraft) => void;
  errors: Record<string, string>;
  idPrefix: string;
  disabled?: boolean;
}) {
  const def = connectorDef(kind);
  if (def.fields.length === 0) {
    return <p className="text-sm text-muted">No configuration needed. Upload documents from the source page after creating it.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {def.fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const common = {
          id,
          value: draft[f.key] ?? "",
          placeholder: f.placeholder,
          disabled,
          "aria-invalid": errors[f.key] ? true : undefined,
          "aria-describedby": errors[f.key] ? `${id}-error` : f.hint ? `${id}-hint` : undefined,
        };
        return (
          <Field key={f.key} label={f.label} htmlFor={id} hint={f.hint} error={errors[f.key]} optional={!f.required}>
            {f.kind === "list" ? (
              <Textarea {...common} rows={3} className="font-mono text-xs" onChange={(e) => onChange({ ...draft, [f.key]: e.target.value })} />
            ) : (
              <Input
                {...common}
                type={f.kind === "number" ? "number" : "text"}
                min={f.kind === "number" ? 0 : undefined}
                max={f.kind === "number" ? 5 : undefined}
                className={f.kind === "text" ? "font-mono text-xs" : undefined}
                onChange={(e) => onChange({ ...draft, [f.key]: e.target.value })}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}
