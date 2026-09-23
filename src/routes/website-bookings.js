/**
 * Proxy route to fetch bookings from website API
 * Avoids CORS issues by relaying the request server-side
 */
export async function getWebsiteBookings(request) {
  try {
    const url = 'https://taqwa.blinto.workers.dev/api/bookings/list';
    console.log('Fetching website bookings from:', url);

    const response = await fetch(url);
    console.log('Website API response status:', response.status);

    if (!response.ok) {
      const body = await response.text();
      console.error('Website API error:', response.status, body);
      return { ok: false, data: null, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    console.log('Website bookings fetched:', data.bookings?.length || 0, 'items');
    return { ok: true, data };
  } catch (error) {
    console.error('Error proxying website bookings:', error.message);
    return { ok: false, data: null, error: error.message };
  }
}
