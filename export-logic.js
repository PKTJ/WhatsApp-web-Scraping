function compareMessageTimes(a, b) {
  const aDom = Number(a?.dom_order_position ?? Number.POSITIVE_INFINITY);
  const bDom = Number(b?.dom_order_position ?? Number.POSITIVE_INFINITY);

  if (Number.isFinite(aDom) && Number.isFinite(bDom)) {
    const visualDifference = aDom - bDom;
    if (visualDifference !== 0) return visualDifference;
  } else if (Number.isFinite(aDom)) {
    return -1;
  } else if (Number.isFinite(bDom)) {
    return 1;
  }

  if (a?.timestamp_iso && b?.timestamp_iso) {
    const timeDifference = new Date(a.timestamp_iso).getTime() - new Date(b.timestamp_iso).getTime();
    if (timeDifference !== 0) return timeDifference;
  } else if (a?.timestamp_iso) {
    return -1;
  } else if (b?.timestamp_iso) {
    return 1;
  }

  return (Number(a?._capture_order || 0) - Number(b?._capture_order || 0));
}

function sortMessagesChronologically(messages = []) {
  return [...messages].sort(compareMessageTimes);
}

function buildGroupedJsonPayload(groups = []) {
  const normalizedGroups = Array.isArray(groups) ? groups.filter(Boolean) : [];
  const orderedGroups = normalizedGroups.map((chat) => {
    const messages = sortMessagesChronologically(chat?.messages || []);
    return {
      ...chat,
      messages,
      message_count: messages.length
    };
  });

  const flattened = [];
  for (let index = 0; index < orderedGroups.length; index += 1) {
    if (index > 0) flattened.push('____');
    flattened.push(orderedGroups[index]);
  }

  return {
    schema_version: '2.0',
    group_count: orderedGroups.length,
    chats: flattened,
    exported_at: new Date().toISOString()
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    compareMessageTimes,
    sortMessagesChronologically,
    buildGroupedJsonPayload
  };
}
