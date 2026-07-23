import { create } from '@bufbuild/protobuf';
import {
  NativeToolPolicy as ProtoNativeToolPolicy,
  NativeToolPolicyConfigSchema,
  type NativeToolPolicyConfig,
} from '@ctxmill/proto/sandbox/v1';
import {
  NativeToolPolicySchema,
  type NativeToolPolicy,
} from '@ctxmill/contracts';

/** Encode the validated control-plane policy without collapsing any state. */
export function nativeToolPolicyToProto(
  candidate: NativeToolPolicy,
): NativeToolPolicyConfig {
  const nativeToolPolicy = NativeToolPolicySchema.parse(candidate);
  switch (nativeToolPolicy.policy) {
    case 'all':
      return create(NativeToolPolicyConfigSchema, {
        policy: ProtoNativeToolPolicy.ALL,
      });
    case 'allow':
      return create(NativeToolPolicyConfigSchema, {
        policy: ProtoNativeToolPolicy.ALLOW,
        names: [...nativeToolPolicy.names],
      });
    case 'deny':
      return create(NativeToolPolicyConfigSchema, {
        policy: ProtoNativeToolPolicy.DENY,
        names: [...nativeToolPolicy.names],
      });
    case 'none':
      return create(NativeToolPolicyConfigSchema, {
        policy: ProtoNativeToolPolicy.NONE,
      });
  }
}
