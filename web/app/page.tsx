import ChatView from '@/components/pages/ChatView';

export default function Page() {
  const backend = (process.env.BOOKING_BACKEND ?? 'mock').toLowerCase();
  return <ChatView backend={backend} />;
}
