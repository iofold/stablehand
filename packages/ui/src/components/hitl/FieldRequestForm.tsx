import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDown, Loader2 } from 'lucide-react';

interface FormField {
  name: string;
  type: 'text' | 'number' | 'date' | 'select' | 'textarea';
  label: string;
  required?: boolean;
  options?: string[];
}

export interface FieldRequestFormProps {
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleChange = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: false }));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
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

    if (isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await Promise.resolve(onSubmit(values));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit');
      setIsSubmitting(false);
      return;
    }
    setIsSubmitting(false);
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
                disabled={isSubmitting}
                className={cn(inputClasses(field.name), 'resize-y min-h-[80px] disabled:opacity-50 disabled:cursor-not-allowed')}
                rows={4}
              />
            ) : field.type === 'select' ? (
              <div className="relative">
                <select
                  value={values[field.name]}
                  onChange={(e) => handleChange(field.name, e.target.value)}
                  disabled={isSubmitting}
                  required={field.required}
                  className={cn(inputClasses(field.name), 'appearance-none pr-8 disabled:opacity-50 disabled:cursor-not-allowed')}
                >
                  <option value="">Select...</option>
                  {field.options?.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-400 pointer-events-none" />
              </div>
            ) : (
              <input
                type={field.type}
                value={values[field.name]}
                onChange={(e) => handleChange(field.name, e.target.value)}
                disabled={isSubmitting}
                className={cn(inputClasses(field.name), 'disabled:opacity-50 disabled:cursor-not-allowed')}
              />
            )}

            {errors[field.name] && (
              <p className="mt-1 text-xs text-status-error">This field is required</p>
            )}
          </div>
        ))}

        {submitError && (
          <div className="text-sm text-status-error bg-status-error/10 px-3 py-2 rounded-md">
            {submitError}
          </div>
        )}

        <button
          data-testid="submit-button"
          type="submit"
          disabled={isSubmitting}
          className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitLabel}
        </button>
      </form>
    </div>
  );
}
