import type { ComponentType } from 'react';
import { ApprovalCard } from '@/components/hitl/ApprovalCard';
import { EditableDocument } from '@/components/hitl/EditableDocument';
import { FieldRequestForm } from '@/components/hitl/FieldRequestForm';

type AnyProps = Record<string, unknown>;

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

type Field = {
  name: string;
  type: 'text' | 'number' | 'date' | 'select' | 'textarea';
  label: string;
  required?: boolean;
  options?: string[];
};

function asFields(value: unknown): Field[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((field) => {
    if (!field || typeof field !== 'object') return [];
    const candidate = field as Record<string, unknown>;
    if (
      typeof candidate.name !== 'string'
      || typeof candidate.label !== 'string'
      || typeof candidate.type !== 'string'
    ) {
      return [];
    }
    if (!['text', 'number', 'date', 'select', 'textarea'].includes(candidate.type)) {
      return [];
    }
    return [{
      name: candidate.name,
      label: candidate.label,
      type: candidate.type as Field['type'],
      required: candidate.required === true,
      options: Array.isArray(candidate.options)
        ? candidate.options.filter((option): option is string => typeof option === 'string')
        : undefined,
    }];
  });
}

function GenericApprovalCard(props: AnyProps) {
  const action = asString(props.action, asString(props.toolName, 'approval_required'));
  const details = asObject(props.details) ?? asObject(props.args);
  return (
    <ApprovalCard
      title={asString(props.title, 'Approval Required')}
      description={asString(props.description, 'Review the requested action below.')}
      action={action}
      details={details}
      onApprove={() => {}}
      onReject={() => {}}
    />
  );
}

function GenericEditableDocument(props: AnyProps) {
  return (
    <EditableDocument
      title={asString(props.title, 'Review Document')}
      content={asString(props.content)}
      format={asString(props.format) || undefined}
      onSubmit={() => {}}
      onCancel={() => {}}
    />
  );
}

function GenericFieldRequestForm(props: AnyProps) {
  return (
    <FieldRequestForm
      title={asString(props.title, 'Additional Information')}
      fields={asFields(props.fields)}
      submitLabel={asString(props.submitLabel, 'Submit')}
      onSubmit={() => {}}
    />
  );
}

export const hitlBlockAdapters: Record<string, ComponentType<AnyProps>> = {
  ApprovalCard: GenericApprovalCard,
  EditableDocument: GenericEditableDocument,
  FieldRequestForm: GenericFieldRequestForm,
};
