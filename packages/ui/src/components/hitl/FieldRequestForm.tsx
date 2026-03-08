import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';

interface FormField {
  name: string;
  type: 'text' | 'number' | 'date' | 'select' | 'textarea';
  label: string;
  required?: boolean;
  options?: string[];
}

interface FieldRequestFormProps {
  title: string;
  fields: FormField[];
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => void;
}

export function FieldRequestForm({ title, fields, submitLabel = 'Submit', onSubmit }: FieldRequestFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of fields) {
      initial[field.name] = '';
    }
    return initial;
  });
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  const handleChange = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: false }));
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const newErrors: Record<string, boolean> = {};
    let hasError = false;

    for (const field of fields) {
      if (field.required && !values[field.name]?.trim()) {
        newErrors[field.name] = true;
        hasError = true;
      }
    }

    if (hasError) {
      setErrors(newErrors);
      return;
    }

    onSubmit(values);
  };

  const inputClasses = (name: string) =>
    cn(
      'w-full rounded-lg border bg-zinc-800 px-3 py-2 text-sm text-zinc-200',
      'focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500',
      'placeholder:text-zinc-600',
      errors[name] ? 'border-rose-500' : 'border-zinc-700',
    );

  return (
    <div data-testid="field-request-form" className="rounded-lg border border-zinc-700 bg-zinc-900 p-5">
      <h3 className="text-base font-semibold text-zinc-100 mb-4">{title}</h3>

      <form onSubmit={handleSubmit} className="space-y-4">
        {fields.map((field) => (
          <div key={field.name}>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">
              {field.label}
              {field.required && <span className="text-rose-400 ml-1">*</span>}
            </label>

            {field.type === 'textarea' ? (
              <textarea
                value={values[field.name]}
                onChange={(e) => handleChange(field.name, e.target.value)}
                className={cn(inputClasses(field.name), 'resize-y min-h-[80px]')}
                rows={4}
              />
            ) : field.type === 'select' ? (
              <div className="relative">
                <select
                  value={values[field.name]}
                  onChange={(e) => handleChange(field.name, e.target.value)}
                  className={cn(inputClasses(field.name), 'appearance-none pr-8')}
                >
                  <option value="">Select...</option>
                  {field.options?.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500 pointer-events-none" />
              </div>
            ) : (
              <input
                type={field.type}
                value={values[field.name]}
                onChange={(e) => handleChange(field.name, e.target.value)}
                className={inputClasses(field.name)}
              />
            )}

            {errors[field.name] && (
              <p className="mt-1 text-xs text-rose-400">This field is required</p>
            )}
          </div>
        ))}

        <button
          data-testid="submit-button"
          type="submit"
          className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-500 transition-colors"
        >
          {submitLabel}
        </button>
      </form>
    </div>
  );
}
