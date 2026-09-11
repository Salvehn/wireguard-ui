import { Check, ChevronDown } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type SelectOption = { value: string; label: string };

export function Select({
  options,
  value,
  onChange,
  label,
  icon,
  disabled,
}: {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const idBase = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    list.current?.focus({ preventScroll: true });
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const select = (next: string) => {
    setOpen(false);
    toggle.current?.focus({ preventScroll: true });
    if (next !== value) onChange(next);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        select(options[activeIndex]?.value ?? value);
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        toggle.current?.focus({ preventScroll: true });
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };
  return (
    <div className="select" ref={root}>
      <button
        ref={toggle}
        type="button"
        className="select-toggle"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        <span>{options[selectedIndex]?.label}</span>
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={"select-chevron" + (open ? " open" : "")}
        />
      </button>
      {open && (
        <ul
          ref={list}
          className="select-list"
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${idBase}-${activeIndex}`}
          onKeyDown={onKeyDown}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${idBase}-${index}`}
              role="option"
              aria-selected={option.value === value}
              className={"select-option" + (index === activeIndex ? " active" : "")}
              onPointerDown={(event) => {
                event.preventDefault();
                select(option.value);
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={13} aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
