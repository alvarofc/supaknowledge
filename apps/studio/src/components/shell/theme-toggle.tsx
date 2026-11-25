import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { handleRadioKeys, radioTabIndex } from "@/components/ui/radio-group";
import { useTheme } from "@/lib/theme";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const options = [
    { value: "light", label: "Light theme", Icon: Sun },
    { value: "system", label: "System theme", Icon: Monitor },
    { value: "dark", label: "Dark theme", Icon: Moon },
  ] as const;
  const values = options.map((o) => o.value);
  const current = theme === undefined ? -1 : values.indexOf(theme);
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={(e) => handleRadioKeys(e, values, theme, setTheme)}
      className={cn("inline-flex rounded-md border border-line bg-surface-2 p-0.5", className)}
    >
      {options.map(({ value, label, Icon }, i) => {
        // theme is undefined until hydrated (it is only known in the browser)
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={radioTabIndex(i, current)}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn("rounded-[5px] border p-1 transition-colors", active ? "border-line-strong bg-button text-fg shadow-xs" : "border-transparent text-subtle hover:text-fg")}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
