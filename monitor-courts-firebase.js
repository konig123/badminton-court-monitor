import fetch from 'node-fetch';
import admin from 'firebase-admin';

// Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
const projectId = process.env.FIREBASE_PROJECT_ID;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: projectId
});

const db = admin.firestore();
const COLLECTION_NAME = 'court_data';
const DOCUMENT_ID = 'latest';

// Function to fetch court data from LCSD API with retry logic
async function fetchCourtData() {
  const maxRetries = 3;
  const retryDelay = 5000; // 5 seconds
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Fetching court data from LCSD API... (Attempt ${attempt}/${maxRetries})`);
      console.log('API URL: https://data.smartplay.lcsd.gov.hk/rest/cms/api/v1/publ/contents/open-data/badminton/file');
      
      const response = await fetch('https://data.smartplay.lcsd.gov.hk/rest/cms/api/v1/publ/contents/open-data/badminton/file', {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
        timeout: 60000, // 60 seconds for large data transfer
      });

      console.log(`Response status: ${response.status}`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      console.log('📥 Starting to read response data...');
      const data = await response.json();
      console.log(`✅ Successfully fetched ${data.length} court records`);
      console.log(`📊 Data size: ${JSON.stringify(data).length} characters`);
      return data;
    } catch (error) {
      console.error(`Error fetching court data (Attempt ${attempt}/${maxRetries}):`, error.message);
      
      if (attempt === maxRetries) {
        console.error('All retry attempts failed');
        return null;
      }
      
      console.log(`Retrying in ${retryDelay/1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

// Function to load previous data from Firebase
async function loadPreviousData() {
  try {
    console.log('📂 Loading previous court data from Firebase...');
    
    const docRef = db.collection(COLLECTION_NAME).doc(DOCUMENT_ID);
    const doc = await docRef.get();
    
    if (doc.exists) {
      const data = doc.data();
      console.log(`📊 Loaded ${data.data ? data.data.length : 0} previous court records from Firebase`);
      console.log(`📅 Last updated: ${data.timestamp ? data.timestamp.toDate() : 'Unknown'}`);
      return data.data || [];
    } else {
      console.log('📂 No previous data found in Firebase');
      console.log('🔍 This is the first run');
      return null;
    }
  } catch (error) {
    console.error('❌ Error loading previous data from Firebase:', error);
    console.log('🔍 Will treat this as first run');
    return null;
  }
}

// Function to save current data to Firebase
async function saveCurrentData(data) {
  try {
    console.log('💾 Saving current data to Firebase...');
    
    const docRef = db.collection(COLLECTION_NAME).doc(DOCUMENT_ID);
    await docRef.set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      data: data
    });
    
    console.log('✅ Current data saved to Firebase for next comparison');
  } catch (error) {
    console.error('❌ Error saving current data to Firebase:', error);
  }
}

// Function to format date for display
function formatDate(dateString) {
  const date = new Date(dateString);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = dayNames[date.getDay()];
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${dayName}, ${month}/${day}`;
}

// Function to detect changes and format notifications
function detectChanges(currentData, previousData) {
  const changes = [];
  
  if (!previousData) {
    console.log('First run - storing initial data');
    return changes;
  }

  console.log('🔍 Comparing with previous data...');
  
  // Create a map of previous data for quick lookup
  const previousMap = new Map();
  previousData.forEach(court => {
    const key = `${court.Venue_Name_EN}-${court.Available_Date}-${court.Session_Start_Time}`;
    previousMap.set(key, court);
  });

  // Check for changes in current data
  currentData.forEach(currentCourt => {
    const key = `${currentCourt.Venue_Name_EN}-${currentCourt.Available_Date}-${currentCourt.Session_Start_Time}`;
    const previousCourt = previousMap.get(key);
    
    if (previousCourt) {
      const currentAvailable = parseInt(currentCourt.Available_Courts || 0);
      const previousAvailable = parseInt(previousCourt.Available_Courts || 0);
      
      // Check for new availability or increased availability
      if (currentAvailable > 0 && previousAvailable === 0) {
        // New courts available
        changes.push({
          type: 'new_availability',
          venue: currentCourt.Venue_Name_EN,
          district: currentCourt.District_Name_EN?.trim(),
          date: currentCourt.Available_Date,
          time: `${currentCourt.Session_Start_Time}-${currentCourt.Session_End_Time}`,
          currentCount: currentAvailable,
          previousCount: 0,
          message: `🟢 ${currentCourt.Venue_Name_EN}\n   ${formatDate(currentCourt.Available_Date)} • ${currentCourt.Session_Start_Time}-${currentCourt.Session_End_Time}\n   Now available: ${currentAvailable} courts (was 0)`
        });
      } else if (currentAvailable > previousAvailable && previousAvailable > 0) {
        // More courts available
        const increase = currentAvailable - previousAvailable;
        changes.push({
          type: 'increased_availability',
          venue: currentCourt.Venue_Name_EN,
          district: currentCourt.District_Name_EN?.trim(),
          date: currentCourt.Available_Date,
          time: `${currentCourt.Session_Start_Time}-${currentCourt.Session_End_Time}`,
          currentCount: currentAvailable,
          previousCount: previousAvailable,
          increase: increase,
          message: `🟢 ${currentCourt.Venue_Name_EN}\n   ${formatDate(currentCourt.Available_Date)} • ${currentCourt.Session_Start_Time}-${currentCourt.Session_End_Time}\n   Now available: ${currentAvailable} courts (was ${previousAvailable})`
        });
      }
    }
  });

  return changes;
}

// Function to format notification content
function formatNotificationContent(changes) {
  if (changes.length === 0) {
    return null;
  }

  let title = '🏸 Court Available!';
  let body = '';
  
  if (changes.length === 1) {
    // Single change
    body = changes[0].message;
  } else {
    // Multiple changes
    title = `🏸 ${changes.length} Courts Available!`;
    body = changes.slice(0, 3).map(change => change.message).join('\n\n');
    if (changes.length > 3) {
      body += `\n\n... and ${changes.length - 3} more changes`;
    }
  }

  return { title, body, changes };
}

// Main function
async function main() {
  try {
    console.log('🏸 Starting Firebase-powered badminton court monitoring...');
    
    // Test basic connectivity first
    console.log('🔍 Testing basic connectivity...');
    try {
      const testResponse = await fetch('https://httpbin.org/get', { timeout: 5000 });
      console.log('✅ Basic internet connectivity: OK');
    } catch (error) {
      console.log('❌ Basic internet connectivity failed:', error.message);
    }
    
    // Load previous data from Firebase
    const previousData = await loadPreviousData();
    
    // Fetch current data
    const currentData = await fetchCourtData();
    if (!currentData) {
      console.log('❌ Failed to fetch court data');
      return;
    }

    // Detect changes
    console.log('🔍 Detecting changes...');
    const changes = detectChanges(currentData, previousData);
    
    // Format notification content
    const notificationContent = formatNotificationContent(changes);
    
    if (notificationContent) {
      console.log(`🔔 Found ${changes.length} changes!`);
      console.log('📱 Notification content:');
      console.log(`Title: ${notificationContent.title}`);
      console.log(`Body: ${notificationContent.body}`);
      
      // Output structured data for GitHub Actions
      console.log('=== CHANGES_DETECTED ===');
      console.log(JSON.stringify(notificationContent));
      console.log('=== END_CHANGES ===');
    } else {
      console.log('✅ No changes detected');
    }
    
    // Save current data to Firebase for next comparison
    await saveCurrentData(currentData);
    
    console.log('✅ Firebase-powered monitoring cycle completed');
    
  } catch (error) {
    console.error('❌ Error in Firebase-powered monitoring cycle:', error);
  } finally {
    // Clean up Firebase connection
    await admin.app().delete();
  }
}

// Run the main function
main(); 