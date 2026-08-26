import { NextRequest } from 'next/server';

import { deleteTraveller, listTravellers, saveTraveller } from '@/lib/travellers';
import type { Contact, Passenger } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * Saved travellers, so a passport is typed once rather than every booking.
 *
 * GET returns summaries only — never a document number. The full record is
 * read server-side when a booking is drafted and goes straight to the airline,
 * so passport numbers stay out of the browser and out of the agent's context.
 */
export async function GET() {
  try {
    return Response.json({ travellers: listTravellers() });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: { passenger?: Passenger; contact?: Contact };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { passenger, contact } = body;
  if (!passenger?.firstName || !passenger?.lastName || !passenger?.dateOfBirth) {
    return Response.json(
      { error: 'passenger needs firstName, lastName and dateOfBirth' },
      { status: 400 },
    );
  }
  if (!contact?.email || !contact?.phone) {
    return Response.json({ error: 'contact needs email and phone' }, { status: 400 });
  }

  try {
    return Response.json({ traveller: saveTraveller(passenger, contact) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
  return Response.json({ deleted: deleteTraveller(id) });
}
