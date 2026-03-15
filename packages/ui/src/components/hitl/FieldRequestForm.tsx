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
      'input-base w-full',
      errors[name] && 'border-status-error focus:border-status-error focus:ring-status-error/50',
    );

  return (
    <div data-testid="field-request-form" className="rounded-lg border border-surface-700 bg-surface-900 p-5">
      <h3 className="text-base font-semibold text-surface-100 mb-4">{title}</h3>

      <form onSubmit={handleSubmit} className="space-y-4">
        {fields.map((field) => (
          <div key={field.name}>
            <label className="text-label block mb-1.5">
              {field.label}
              {field.required && <span className="text-status-error ml-1">*</span>}
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
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-500 pointer-events-none" />
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
              <p className="mt-1 text-xs text-status-error">This field is required</p>
            )}
          </div>
        ))}

        <button
          data-testid="submit-button"
          type="submit"
          className="btn-primary"
        >
          {submitLabel}
        </button>
      </form>
    </div>
  );
}
