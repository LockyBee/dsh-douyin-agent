const bindingPattern = /^binding:[a-f0-9]{64}$/;
const conversationPattern = /^conv:[a-f0-9]{64}$/;
const nameOf = value => value?.name || value?.displayName;
export const MAX_AUTHORIZED_CONTACTS = null;
const conversation = value => value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 500 && typeof value.isGroup === 'boolean' && typeof nameOf(value) === 'string' && Boolean(nameOf(value).trim());

export function hasVerifiedConversationIdentity(value) {
  return Boolean(conversation(value) && conversationPattern.test(value.id) && value.identityVerified === true && bindingPattern.test(value.identityBinding || ''));
}

export function hasStableConversationIdentity(value) {
  return Boolean(hasVerifiedConversationIdentity(value) && value.identityVersion === 2
    && ['native-conversation', 'rendered-conversation', 'rendered-conversation-short', 'rendered-group', 'rendered-user', 'rendered-user-id', 'profile-user'].includes(value.identityKind)
    && (value.isGroup ? !['rendered-user', 'rendered-user-id', 'profile-user'].includes(value.identityKind) : value.identityKind !== 'rendered-group')
    && /^[a-f0-9]{64}$/.test(value.identityHash || '') && value.identityHash === value.id.slice(5));
}

// 网页没有提供关注关系时，只有本人核对后才能授权现有会话；群聊始终单独核对。
export function canAuthorizeConversation(value) {
  return Boolean(hasVerifiedConversationIdentity(value) && (value.identityVersion === undefined || hasStableConversationIdentity(value)) && (value.isGroup === true || value.relationshipStatus === 'unavailable' && value.followed !== true));
}

export function isStoredContactAuthorized(value) {
  if (!conversation(value) || typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt))) return false;
  if (['identityVersion', 'identityKind', 'identityHash'].some(key => value[key] !== undefined) && !hasStableConversationIdentity(value)) return false;
  if (value.authorizationKind === 'manual') return true;
  if (value.authorizationKind === 'existing-group') return value.isGroup === true && canAuthorizeConversation(value);
  if (value.authorizationKind === 'existing-conversation') return value.isGroup === false && canAuthorizeConversation(value);
  return value.isGroup === false && value.followed === true && (value.authorizationKind === undefined || value.authorizationKind === 'following');
}

export function matchesAuthorizedContact(stored, current) {
  if (!isStoredContactAuthorized(stored) || !conversation(current) || current.id !== stored.id || current.isGroup !== stored.isGroup) return false;
  if (stored.authorizationKind === 'manual') return true;
  if (hasStableConversationIdentity(stored)) return hasStableConversationIdentity(current) && current.identityKind === stored.identityKind && current.identityHash === stored.identityHash && current.identityBinding === stored.identityBinding && (['existing-conversation', 'existing-group'].includes(stored.authorizationKind) || current.followed === true);
  if (stored.identityVersion !== undefined) return false;
  if (['existing-conversation', 'existing-group'].includes(stored.authorizationKind)) {
    if (hasStableConversationIdentity(current)) return true;
    return nameOf(current) === nameOf(stored) && hasVerifiedConversationIdentity(current) && current.identityBinding === stored.identityBinding;
  }
  if (hasStableConversationIdentity(current)) return false;
  if (nameOf(current) !== nameOf(stored)) return false;
  if (current.followed !== true) return false;
  return !stored.identityBinding || hasVerifiedConversationIdentity(current) && current.identityBinding === stored.identityBinding;
}

// 旧许可只能升级原来的稳定会话 ID 和类型，不能用同名或头像寻找替代账号。
export function upgradeAuthorizedContact(stored, current) {
  if (!isStoredContactAuthorized(stored) || !hasStableConversationIdentity(current) || stored.id !== current.id || stored.isGroup !== current.isGroup) return null;
  if (hasStableConversationIdentity(stored)) {
    if (!matchesAuthorizedContact(stored, current)) return null;
  } else if (stored.identityVersion !== undefined || !['existing-conversation', 'existing-group'].includes(stored.authorizationKind) || !hasVerifiedConversationIdentity(stored)) return null;
  return { ...stored, name: nameOf(current), identityVersion: 2, identityKind: current.identityKind, identityHash: current.identityHash, identityVerified: true, identityBinding: current.identityBinding };
}

