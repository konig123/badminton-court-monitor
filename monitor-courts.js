const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Store previous data (in production, use a database)
let previousData = null;

async function fetchCourtData() {
  try {
    console.log('Fetching court data from LCSD API...');
    
    const response = await fetch('https://data.smartplay.lcsd.gov.hk/rest/cms/api/v1/publ/contents/open-data/badminton/file', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'BadmintonCourtMonitor/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log(`Successfully fetched ${data.length} court records`);
    return data;
  } catch (error) {
    console.error('Error fetching court data:', error);
    return null;
  }
}

function detectChanges(currentData, previousData) {
  if (!previousData) {
    console.log('First run - storing initial data');
    return [];
  }

  const changes = [];
  
  // Group by venue and time slot for comparison
  const currentMap = new Map();
  const previousMap = new Map();

  // Process current data
  currentData.forEach(court => {
    const key = `${court.Venue_Name_EN}-${court.Available_Date}-${court.Session_Start_Time}`;
    currentMap.set(key, court);
  });

  // Process previous data
  previousData.forEach(court => {
    const key = `${court.Venue_Name_EN}-${court.Available_Date}-${court.Session_Start_Time}`;
    previousMap.set(key, court);
  });

  // Detect changes
  currentMap.forEach((currentCourt, key) => {
    const previousCourt = previousMap.get(key);
    
    if (previousCourt) {
      const currentAvailable = parseInt(currentCourt.Available_Courts || 0);
      const previousAvailable = parseInt(previousCourt.Available_Courts || 0);
      
      // New availability (0 → 1+)
      if (currentAvailable > 0 && previousAvailable === 0) {
        changes.push({
          type: 'new_availability',
          venue: currentCourt.Venue_Name_EN,
          district: currentCourt.District_Name_EN?.trim(),
          date: currentCourt.Available_Date,
          time: `${currentCourt.Session_Start_Time}-${currentCourt.Session_End_Time}`,
          courts: currentAvailable,
          previous: 0
        });
      }
      // Increased availability
      else if (currentAvailable > previousAvailable) {
        changes.push({
          type: 'increased_availability',
          venue: currentCourt.Venue_Name_EN,
          district: currentCourt.District_Name_EN?.trim(),
          date: currentCourt.Available_Date,
          time: `${currentCourt.Session_Start_Time}-${currentCourt.Session_End_Time}`,
          courts: currentAvailable,
          previous: previousAvailable
        });
      }
    }
  });

  return changes;
}

function formatNotificationMessage(changes) {
  if (changes.length === 0) {
    return 'No changes detected';
  }

  let message = '�� AVAILABILITY CHANGES:\n';
  message += '------------------------------\n\n';

  changes.forEach(change => {
    const date = new Date(change.date);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
    const formattedDate = `${dayName}, ${change.date.split('-').slice(1).join('/')}`;
    
    message += `🟢 ${change.venue}\n`;
    message += `   ${formattedDate} • ${change.time}\n`;
    message += `   Now available: ${change.courts} courts (was ${change.previous})\n\n`;
  });

  return message;
}

async function main() {
  try {
    console.log('�� Starting badminton court monitoring...');
    
    // Fetch current data
    const currentData = await fetchCourtData();
    if (!currentData) {
      console.log('❌ Failed to fetch court data');
      return;
    }

    // Detect changes
    const changes = detectChanges(currentData, previousData);
    
    if (changes.length > 0) {
      console.log(`🔔 Found ${changes.length} changes!`);
      const message = formatNotificationMessage(changes);
      console.log(message);
      
      // In a real implementation, you would send push notifications here
      // For now, we'll just log the changes
      console.log('�� Changes detected - would send notifications here');
    } else {
      console.log('✅ No changes detected');
    }

    // Store current data for next comparison
    previousData = currentData;
    
    console.log('✅ Monitoring cycle completed');
    
  } catch (error) {
    console.error('❌ Error in monitoring cycle:', error);
  }
}

// Run the monitoring
main();
