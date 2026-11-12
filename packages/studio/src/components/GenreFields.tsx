import { genreCategoriesForLanguage, type GenreParts } from "../lib/genre";

export function GenreFields({
  language,
  value,
  onChange,
  categoryPlaceholder,
  detailPlaceholder,
  className,
  selectClassName,
  inputClassName,
}: {
  language: "zh" | "en";
  value: GenreParts;
  onChange: (next: GenreParts) => void;
  categoryPlaceholder: string;
  detailPlaceholder: string;
  className?: string;
  selectClassName?: string;
  inputClassName?: string;
}) {
  const categories = genreCategoriesForLanguage(language);
  return (
    <div className={className}>
      <select
        value={value.category}
        onChange={(event) => onChange({ ...value, category: event.target.value })}
        className={selectClassName}
      >
        <option value="" disabled>{categoryPlaceholder}</option>
        {categories.map((category) => <option key={category} value={category}>{category}</option>)}
      </select>
      <input
        value={value.detail}
        onChange={(event) => onChange({ ...value, detail: event.target.value })}
        placeholder={detailPlaceholder}
        className={inputClassName}
      />
    </div>
  );
}
