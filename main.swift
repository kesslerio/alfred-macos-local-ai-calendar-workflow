import EventKit
import Foundation

let eventStore = EKEventStore()

func requestAccessSync() -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var isGranted = false
    
    if #available(macOS 14.0, *) {
        eventStore.requestFullAccessToEvents { granted, error in
            isGranted = granted
            semaphore.signal()
        }
    } else {
        eventStore.requestAccess(to: .event) { granted, error in
            isGranted = granted
            semaphore.signal()
        }
    }
    
    _ = semaphore.wait(timeout: .distantFuture)
    return isGranted
}

func findCalendar(name: String) -> EKCalendar? {
    let calendars = eventStore.calendars(for: .event)
    return calendars.first { $0.title.lowercased() == name.lowercased() }
}

func parseISO8601Date(string: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: string) {
        return date
    }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: string)
}

func getArgValue(flag: String) -> String? {
    let args = CommandLine.arguments
    if let index = args.firstIndex(of: flag), index + 1 < args.count {
        return args[index + 1]
    }
    return nil
}

func printJSON(_ obj: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let jsonString = String(data: data, encoding: .utf8) {
        print(jsonString)
    } else {
        print("[]")
    }
}

// MAIN EXECUTION
func main() {
    let args = CommandLine.arguments
    guard args.count > 1 else {
        print("Usage: local-calendar-helper [create|search|delete|update] [options]")
        exit(1)
    }
    
    let command = args[1]
    
    switch command {
    case "create":
        guard let title = getArgValue(flag: "--title"),
              let startStr = getArgValue(flag: "--start"),
              let endStr = getArgValue(flag: "--end"),
              let calendarName = getArgValue(flag: "--calendar") else {
            print("Error: Missing required arguments for create. Needs --title, --start, --end, --calendar")
            exit(1)
        }
        
        guard let startDate = parseISO8601Date(string: startStr),
              let endDate = parseISO8601Date(string: endStr) else {
            print("Error: Invalid date formats.")
            exit(1)
        }
        
        guard requestAccessSync() else {
            print("Error: Access denied.")
            exit(1)
        }
        
        let calendar = findCalendar(name: calendarName) ?? eventStore.defaultCalendarForNewEvents
        guard let targetCalendar = calendar else {
            print("Error: Target calendar not found and no default available.")
            exit(1)
        }
        
        let event = EKEvent(eventStore: eventStore)
        event.title = title
        event.startDate = startDate
        event.endDate = endDate
        event.calendar = targetCalendar
        
        do {
            try eventStore.save(event, span: .thisEvent)
            print("Success: Added '\(title)' to '\(targetCalendar.title)' (ID: \(event.eventIdentifier ?? ""))")
        } catch {
            print("Error: Failed to save event: \(error.localizedDescription)")
            exit(1)
        }
        
    case "search":
        let query = getArgValue(flag: "--query") ?? ""
        let startStr = getArgValue(flag: "--start")
        let endStr = getArgValue(flag: "--end")
        
        var startDate = Date().addingTimeInterval(-86400 * 7) // 7 days ago default
        var endDate = Date().addingTimeInterval(86400 * 30)   // 30 days future default
        
        if let startStr = startStr, let d = parseISO8601Date(string: startStr) {
            startDate = d
        }
        if let endStr = endStr, let d = parseISO8601Date(string: endStr) {
            endDate = d
        }
        
        guard requestAccessSync() else {
            print("[]")
            exit(1)
        }
        
        let predicate = eventStore.predicateForEvents(withStart: startDate, end: endDate, calendars: nil)
        let events = eventStore.events(matching: predicate)
        
        let filtered = events.filter { event in
            if query.isEmpty { return true }
            guard let title = event.title else { return false }
            return title.lowercased().contains(query.lowercased())
        }
        
        let results = filtered.map { event -> [String: String] in
            return [
                "id": event.eventIdentifier ?? "",
                "title": event.title ?? "",
                "start_date": ISO8601DateFormatter().string(from: event.startDate),
                "end_date": ISO8601DateFormatter().string(from: event.endDate),
                "calendar": event.calendar?.title ?? ""
            ]
        }
        printJSON(results)
        
    case "delete":
        guard let id = getArgValue(flag: "--id") else {
            print("Error: Missing --id")
            exit(1)
        }
        
        guard requestAccessSync() else {
            print("Error: Access denied.")
            exit(1)
        }
        
        guard let event = eventStore.event(withIdentifier: id) else {
            print("Error: Event not found.")
            exit(1)
        }
        
        do {
            try eventStore.remove(event, span: .thisEvent)
            print("Success: Deleted event '\(event.title ?? "")'")
        } catch {
            print("Error: Failed to delete: \(error.localizedDescription)")
            exit(1)
        }
        
    case "update":
        guard let id = getArgValue(flag: "--id") else {
            print("Error: Missing --id")
            exit(1)
        }
        
        guard requestAccessSync() else {
            print("Error: Access denied.")
            exit(1)
        }
        
        guard let event = eventStore.event(withIdentifier: id) else {
            print("Error: Event not found.")
            exit(1)
        }
        
        if let title = getArgValue(flag: "--title") {
            event.title = title
        }
        if let startStr = getArgValue(flag: "--start"), let d = parseISO8601Date(string: startStr) {
            event.startDate = d
        }
        if let endStr = getArgValue(flag: "--end"), let d = parseISO8601Date(string: endStr) {
            event.endDate = d
        }
        if let calendarName = getArgValue(flag: "--calendar"), let cal = findCalendar(name: calendarName) {
            event.calendar = cal
        }
        
        do {
            try eventStore.save(event, span: .thisEvent)
            print("Success: Updated event '\(event.title ?? "")'")
        } catch {
            print("Error: Failed to update: \(error.localizedDescription)")
            exit(1)
        }
        
    default:
        print("Error: Unknown command '\(command)'")
        exit(1)
    }
}

main()
