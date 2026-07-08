import { redirect } from 'next/navigation';

interface PageProps {
  params: Promise<{ participantId: string }>;
}

export default async function ParticipantPage({ params }: PageProps) {
  const { participantId } = await params;
  redirect(`/${participantId}/1`);
}
